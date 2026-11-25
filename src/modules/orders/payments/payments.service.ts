import { NotificationType, OrderStatus, PaymentStatus, PaymentTransactionType, prisma, Prisma } from '../../../db/client';
import { recordAudit, type AuditContext } from '../../../utils/audit';
import { Errors } from '../../../utils/errors';
import { formatMoney } from '../../../utils/money';
import { notify } from '../../../utils/notifications';
import { refreshManyProductAggregates } from '../../products/aggregates';
import { addHistory, commitOrderStock, confirmOrderTx, lockOrder } from '../order-lifecycle';
import type { NextAction } from './payment.provider';
import { getPaymentProvider } from './providers';

/** Provedores que podem ser confirmados manualmente por quem tem payments:manage. */
const MANUALLY_CONFIRMABLE = new Set(['manual', 'cod']);

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export interface MarkPaidOptions {
  source: 'WEBHOOK' | 'MANUAL';
  amount?: number;
  currency?: string;
  providerTransactionId?: string;
  raw?: Record<string, unknown>;
  actorId?: string;
  note?: string;
}

export class PaymentsService {
  /** Chama o provider; nunca marca como pago (isso só acontece via webhook verificado ou admin). */
  async initiate(paymentId: string): Promise<{ status: PaymentStatus; nextAction: NextAction }> {
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { paymentMethod: true, order: { select: { orderNumber: true, user: { select: { email: true, phone: true, name: true } } } } },
    });
    const provider = getPaymentProvider(payment.provider);
    try {
      const result = await provider.initiate({
        paymentId: payment.id,
        orderNumber: payment.order.orderNumber,
        amount: payment.amount,
        currency: payment.currency,
        customer: payment.order.user,
        methodConfig: (payment.paymentMethod?.config as Record<string, unknown> | null) ?? null,
        instructions: payment.paymentMethod?.instructions,
      });
      const status = result.status === 'PROCESSING' ? PaymentStatus.PROCESSING : PaymentStatus.PENDING;
      await prisma.$transaction([
        prisma.payment.update({ where: { id: paymentId }, data: { status, providerReference: result.providerReference } }),
        prisma.paymentTransaction.create({
          data: { paymentId, type: PaymentTransactionType.INITIATION, status, amount: payment.amount, providerTransactionId: result.providerReference, rawResponse: result.raw as Prisma.InputJsonValue | undefined },
        }),
        prisma.order.update({ where: { id: payment.orderId }, data: { paymentStatus: status } }),
      ]);
      return { status, nextAction: result.nextAction };
    } catch (err) {
      const reason = (err as Error).message.slice(0, 300);
      await prisma.$transaction([
        prisma.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.FAILED, failedAt: new Date(), failureReason: reason } }),
        prisma.paymentTransaction.create({ data: { paymentId, type: PaymentTransactionType.FAILURE, status: PaymentStatus.FAILED, amount: payment.amount, rawResponse: { error: reason } } }),
        prisma.order.update({ where: { id: payment.orderId }, data: { paymentStatus: PaymentStatus.FAILED } }),
      ]);
      return { status: PaymentStatus.FAILED, nextAction: { type: 'NONE' } };
    }
  }

  /**
   * Confirma o pagamento de forma idempotente:
   * lock do pagamento → se já PAID não faz nada → valida valor → PAID → consome reservas → pedido CONFIRMED.
   */
  async markPaid(paymentId: string, opts: MarkPaidOptions): Promise<{ alreadyPaid: boolean; orderId: string }> {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        if (payment.status === PaymentStatus.PAID) return { alreadyPaid: true, orderId: payment.orderId, productIds: [] as string[], confirmed: false };

        if (opts.amount !== undefined && opts.amount !== payment.amount) {
          throw Errors.unprocessable('PAYMENT_AMOUNT_MISMATCH', 'Paid amount does not match the order total', { expected: payment.amount, received: opts.amount });
        }
        if (opts.currency && opts.currency.toUpperCase() !== payment.currency) {
          throw Errors.unprocessable('PAYMENT_CURRENCY_MISMATCH', 'Currency does not match');
        }

        await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.PAID, paidAt: new Date(), failureReason: null } });
        await tx.paymentTransaction.create({
          data: {
            paymentId,
            type: opts.source === 'MANUAL' ? PaymentTransactionType.MANUAL_CONFIRMATION : PaymentTransactionType.PAYMENT,
            status: PaymentStatus.PAID,
            amount: payment.amount,
            providerTransactionId: opts.providerTransactionId,
            rawResponse: opts.raw as Prisma.InputJsonValue | undefined,
            createdById: opts.actorId,
          },
        });

        const order = await lockOrder(tx, payment.orderId);
        if (!order) throw Errors.notFound('Order');
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.PAID } });

        let confirmed = false;
        if (order.status === OrderStatus.PENDING) {
          const stock = await commitOrderStock(tx, order, opts.actorId);
          if (stock.ok) {
            await confirmOrderTx(tx, order, `Payment confirmed (${opts.source.toLowerCase()})`, opts.actorId);
            confirmed = true;
          } else {
            // Reserva expirou e o stock acabou entretanto: pago mas sem stock => intervenção humana.
            await tx.order.update({ where: { id: order.id }, data: { requiresAttention: true, adminNote: `Paid but out of stock: ${stock.failedSkus.join(', ')}` } });
            await addHistory(tx, order.id, order.status, order.status, `Payment received but stock unavailable for ${stock.failedSkus.join(', ')}`, opts.actorId);
          }
        } else if (order.status === OrderStatus.CANCELLED) {
          await tx.order.update({ where: { id: order.id }, data: { requiresAttention: true, adminNote: 'Payment received for a cancelled order — refund required' } });
          await tx.refund.upsert({
            where: { idempotencyKey: `refund:late-payment:${paymentId}` },
            update: {},
            create: { paymentId, amount: payment.amount, reason: 'Payment received after order cancellation', idempotencyKey: `refund:late-payment:${paymentId}` },
          });
          await addHistory(tx, order.id, order.status, order.status, 'Payment received after cancellation — refund created', opts.actorId);
        }
        return { alreadyPaid: false, orderId: order.id, productIds: order.items.map((i) => i.productId).filter((x): x is string => Boolean(x)), confirmed, userId: order.userId, orderNumber: order.orderNumber, amount: payment.amount, currency: payment.currency };
      },
      { timeout: 15_000 },
    );

    if (!outcome.alreadyPaid) {
      await refreshManyProductAggregates(outcome.productIds);
      if ('userId' in outcome && outcome.userId) {
        await notify({
          userId: outcome.userId,
          type: NotificationType.PAYMENT_CONFIRMED,
          title: `Pagamento confirmado — ${outcome.orderNumber}`,
          body: `Recebemos ${formatMoney(outcome.amount!, outcome.currency)}. ${outcome.confirmed ? 'O seu pedido foi confirmado.' : 'A nossa equipa vai rever o seu pedido.'}`,
          data: { orderId: outcome.orderId },
          email: true,
        });
      }
    }
    return { alreadyPaid: outcome.alreadyPaid, orderId: outcome.orderId };
  }

  async markFailed(paymentId: string, reason: string, raw?: Record<string, unknown>) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (payment.status === PaymentStatus.PAID || payment.status === PaymentStatus.FAILED) return; // idempotente
      await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.FAILED, failedAt: new Date(), failureReason: reason.slice(0, 300) } });
      await tx.paymentTransaction.create({ data: { paymentId, type: PaymentTransactionType.FAILURE, status: PaymentStatus.FAILED, amount: payment.amount, rawResponse: raw as Prisma.InputJsonValue | undefined } });
      // A reserva mantém-se até expirar: o cliente pode tentar pagar de novo.
      await tx.order.updateMany({ where: { id: payment.orderId, paymentStatus: { not: PaymentStatus.PAID } }, data: { paymentStatus: PaymentStatus.FAILED } });
    });
  }

  /**
   * Webhook: valida assinatura → regista evento (unique provider+eventId = idempotência)
   * → atualiza pagamento → confirma pedido → stock → notificação.
   */
  async handleWebhook(providerCode: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
    const provider = getPaymentProvider(providerCode);
    if (!provider.parseWebhook) throw Errors.notFound('Webhook endpoint', 'WEBHOOK_NOT_SUPPORTED');
    const event = provider.parseWebhook(headers, rawBody); // lança 401 se a assinatura for inválida

    let record;
    try {
      record = await prisma.webhookEvent.create({
        data: { provider: providerCode, eventId: event.eventId, eventType: event.type, payload: event.raw as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { duplicate: true };
      throw err;
    }

    try {
      const payment = await prisma.payment.findUnique({ where: { provider_providerReference: { provider: providerCode, providerReference: event.providerReference } } });
      if (!payment) throw Errors.notFound('Payment');
      if (event.type === 'payment.succeeded') {
        await this.markPaid(payment.id, { source: 'WEBHOOK', amount: event.amount, currency: event.currency, providerTransactionId: event.providerTransactionId, raw: event.raw });
      } else if (event.type === 'payment.failed') {
        await this.markFailed(payment.id, event.failureReason ?? 'Payment failed', event.raw);
      }
      await prisma.webhookEvent.update({ where: { id: record.id }, data: { processedAt: new Date() } });
      return { duplicate: false, processed: true };
    } catch (err) {
      await prisma.webhookEvent.update({ where: { id: record.id }, data: { error: (err as Error).message.slice(0, 1000) } });
      // Valor divergente / pagamento desconhecido: aceitar (200) para o gateway não repetir, mas fica registado para análise.
      if (err instanceof Error && 'statusCode' in err && (err as { statusCode: number }).statusCode < 500) return { duplicate: false, processed: false };
      throw err; // erro transitório: 5xx faz o gateway repetir
    }
  }

  /** Nova tentativa de pagamento para pedido PENDING (ex.: falhou o M-Pesa). */
  async retry(userId: string, orderId: string, idempotencyKey: string, paymentMethodCode?: string) {
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey: `retry:${orderId}:${idempotencyKey}` } });
    if (existing) return { paymentId: existing.id, status: existing.status, nextAction: { type: 'NONE' } as NextAction };

    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: { payments: true } });
    if (!order) throw Errors.notFound('Order');
    if (order.status !== OrderStatus.PENDING || order.paymentStatus === PaymentStatus.PAID) {
      throw Errors.unprocessable('ORDER_NOT_PAYABLE', 'This order cannot receive a new payment');
    }
    const method = await prisma.paymentMethod.findFirst({ where: { code: paymentMethodCode ?? order.paymentMethodCode, isActive: true } });
    if (!method) throw Errors.unprocessable('PAYMENT_METHOD_INVALID', 'Payment method is not available');

    let paymentId: string;
    try {
      paymentId = await prisma.$transaction(async (tx) => {
        await tx.payment.updateMany({
          where: { orderId, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
          data: { status: PaymentStatus.CANCELLED },
        });
        const p = await tx.payment.create({
          data: {
            orderId,
            paymentMethodId: method.id,
            methodCode: method.code,
            provider: method.provider,
            amount: order.grandTotal,
            currency: order.currency,
            idempotencyKey: `retry:${orderId}:${idempotencyKey}`,
          },
        });
        return p.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const p = await prisma.payment.findUniqueOrThrow({ where: { idempotencyKey: `retry:${orderId}:${idempotencyKey}` } });
        return { paymentId: p.id, status: p.status, nextAction: { type: 'NONE' } as NextAction };
      }
      throw err;
    }
    const result = await this.initiate(paymentId);
    return { paymentId, ...result };
  }

  /** Confirmação manual (transferência recebida, dinheiro na entrega). Auditada. */
  async confirmManually(ctx: AuditContext, orderId: string, paymentId: string, note: string) {
    const payment = await prisma.payment.findFirst({ where: { id: paymentId, orderId } });
    if (!payment) throw Errors.notFound('Payment');
    if (!MANUALLY_CONFIRMABLE.has(payment.provider)) {
      throw Errors.forbidden('Gateway payments can only be confirmed by the gateway', 'MANUAL_CONFIRMATION_NOT_ALLOWED');
    }
    const result = await this.markPaid(paymentId, { source: 'MANUAL', actorId: ctx.actorId, note });
    if (!result.alreadyPaid) {
      await recordAudit(prisma, ctx, {
        action: 'payment.confirm_manual',
        resourceType: 'Payment',
        resourceId: paymentId,
        before: { status: payment.status },
        after: { status: PaymentStatus.PAID, amount: payment.amount, note },
      });
    }
    return result;
  }

  listMethods() {
    return prisma.paymentMethod.findMany({
      where: { isActive: true },
      select: { code: true, name: true, type: true, instructions: true },
      orderBy: { sortOrder: 'asc' },
    });
  }
}
