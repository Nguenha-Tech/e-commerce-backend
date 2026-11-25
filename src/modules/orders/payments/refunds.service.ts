import { NotificationType, OrderStatus, PaymentStatus, PaymentTransactionType, prisma, Prisma, RefundStatus, ReturnStatus } from '../../../db/client';
import { recordAudit, type AuditContext } from '../../../utils/audit';
import { Errors } from '../../../utils/errors';
import { formatMoney } from '../../../utils/money';
import { notify } from '../../../utils/notifications';
import { pageMeta, toSkipTake } from '../../../utils/pagination';
import { addHistory, lockOrder } from '../order-lifecycle';
import { canTransition } from '../order-state';
import { getPaymentProvider } from './providers';

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Reembolsos ativos (pendentes/em processamento) contam como já comprometidos. */
const OPEN_REFUND: RefundStatus[] = [RefundStatus.PENDING, RefundStatus.PROCESSING];

export interface CreateRefundInput {
  paymentId: string;
  amount: number;
  reason: string;
  returnRequestId?: string;
}

/**
 * Reembolsos — idempotentes (chave única) e nunca acima do valor pago.
 * Fluxo: criar (PENDING) → processar (gateway automático ou registo manual) → COMPLETED.
 */
export class RefundsService {
  async list(q: { page: number; limit: number; status?: RefundStatus }) {
    const where: Prisma.RefundWhereInput = q.status ? { status: q.status } : {};
    const [total, items] = await prisma.$transaction([
      prisma.refund.count({ where }),
      prisma.refund.findMany({
        where,
        include: { payment: { select: { provider: true, methodCode: true, currency: true, order: { select: { id: true, orderNumber: true, user: { select: { name: true, email: true } } } } } } },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  /** Quanto ainda pode ser reembolsado de um pagamento (pago − reembolsado − reembolsos em aberto). */
  async refundable(paymentId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { amount: true, refundedAmount: true, status: true } });
    const open = await db.refund.aggregate({ where: { paymentId, status: { in: OPEN_REFUND } }, _sum: { amount: true } });
    const paid = payment.status === PaymentStatus.PAID || payment.status === PaymentStatus.PARTIALLY_REFUNDED;
    return paid ? Math.max(0, payment.amount - payment.refundedAmount - (open._sum.amount ?? 0)) : 0;
  }

  async create(ctx: AuditContext, input: CreateRefundInput, idempotencyKey: string) {
    const key = `refund:manual:${input.paymentId}:${idempotencyKey}`;
    const existing = await prisma.refund.findUnique({ where: { idempotencyKey: key } });
    if (existing) return { refund: existing, created: false };

    try {
      const refund = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${input.paymentId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
        if (!payment) throw Errors.notFound('Payment');
        const available = await this.refundable(payment.id, tx);
        if (input.amount > available) {
          throw Errors.unprocessable('REFUND_EXCEEDS_PAID_AMOUNT', 'Refund amount exceeds the refundable amount', { refundable: available, requested: input.amount });
        }
        const r = await tx.refund.create({
          data: { paymentId: payment.id, amount: input.amount, reason: input.reason, returnRequestId: input.returnRequestId, idempotencyKey: key, createdById: ctx.actorId },
        });
        await recordAudit(tx, ctx, { action: 'refund.create', resourceType: 'Refund', resourceId: r.id, after: { paymentId: payment.id, amount: input.amount, reason: input.reason } });
        return r;
      });
      return { refund, created: true };
    } catch (err) {
      if (isUniqueViolation(err)) return { refund: await prisma.refund.findUniqueOrThrow({ where: { idempotencyKey: key } }), created: false };
      throw err;
    }
  }

  /**
   * Processa: gateway com refund() => automático; caso contrário o admin regista a referência
   * da devolução feita fora (transferência, M-Pesa manual, dinheiro).
   */
  async process(ctx: AuditContext, refundId: string, input: { providerReference?: string; note?: string }) {
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!refund) throw Errors.notFound('Refund');
    if (refund.status === RefundStatus.COMPLETED) return { refund, alreadyCompleted: true };
    if (refund.status === RefundStatus.FAILED) throw Errors.unprocessable('REFUND_FAILED', 'This refund failed; create a new one');

    const provider = getPaymentProvider(refund.payment.provider);
    let providerReference = input.providerReference;
    let raw: Record<string, unknown> | undefined = input.note ? { note: input.note } : undefined;

    if (provider.refund && refund.status === RefundStatus.PENDING) {
      await prisma.refund.update({ where: { id: refundId }, data: { status: RefundStatus.PROCESSING } });
      try {
        const res = await provider.refund({ refundId, paymentReference: refund.payment.providerReference, amount: refund.amount, currency: refund.payment.currency, reason: refund.reason });
        providerReference = res.providerReference;
        raw = res.raw;
        if (res.status === 'PROCESSING') {
          await prisma.refund.update({ where: { id: refundId }, data: { providerReference } });
          return { refund: await prisma.refund.findUniqueOrThrow({ where: { id: refundId } }), alreadyCompleted: false };
        }
      } catch (err) {
        await prisma.refund.update({ where: { id: refundId }, data: { status: RefundStatus.PENDING } });
        throw Errors.unprocessable('REFUND_GATEWAY_ERROR', `Gateway refused the refund: ${(err as Error).message}`.slice(0, 300));
      }
    } else if (!provider.refund && !providerReference) {
      throw Errors.badRequest('REFUND_REFERENCE_REQUIRED', 'Provide the reference of the manual refund (transfer, receipt…)');
    }

    return this.complete(ctx, refundId, providerReference, raw);
  }

  /** Marca COMPLETED de forma idempotente e propaga para pagamento, pedido e devolução. */
  async complete(ctx: AuditContext, refundId: string, providerReference?: string, raw?: Record<string, unknown>) {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "refunds" WHERE "id" = ${refundId}::uuid FOR UPDATE`;
        const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
        if (refund.status === RefundStatus.COMPLETED) return { refund, alreadyCompleted: true, notifyUser: null };

        await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${refund.paymentId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
        const refundedAmount = payment.refundedAmount + refund.amount;
        if (refundedAmount > payment.amount) throw Errors.unprocessable('REFUND_EXCEEDS_PAID_AMOUNT', 'Refund exceeds the paid amount');
        const paymentStatus = refundedAmount >= payment.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

        const done = await tx.refund.update({ where: { id: refundId }, data: { status: RefundStatus.COMPLETED, providerReference: providerReference ?? refund.providerReference } });
        await tx.payment.update({ where: { id: payment.id }, data: { refundedAmount, status: paymentStatus } });
        await tx.paymentTransaction.create({
          data: { paymentId: payment.id, type: PaymentTransactionType.REFUND, status: paymentStatus, amount: refund.amount, providerTransactionId: providerReference, rawResponse: raw as Prisma.InputJsonValue | undefined, createdById: ctx.actorId },
        });

        const order = await lockOrder(tx, payment.orderId);
        if (!order) throw Errors.notFound('Order');
        const data: Prisma.OrderUpdateInput = { paymentStatus };
        // Pedido cancelado ou devolvido e totalmente reembolsado => REFUNDED.
        const pendingRefunds = await tx.refund.count({ where: { payment: { orderId: order.id }, status: { in: OPEN_REFUND } } });
        if (pendingRefunds === 0) data.requiresAttention = false;
        if (paymentStatus === PaymentStatus.REFUNDED || refund.returnRequestId) {
          if (canTransition(order.status, OrderStatus.REFUNDED)) {
            data.status = OrderStatus.REFUNDED;
            await addHistory(tx, order.id, order.status, OrderStatus.REFUNDED, `Refund ${formatMoney(refund.amount, payment.currency)} completed`, ctx.actorId);
          }
        }
        await tx.order.update({ where: { id: order.id }, data });

        if (refund.returnRequestId) {
          await tx.returnRequest.updateMany({ where: { id: refund.returnRequestId, status: ReturnStatus.RECEIVED }, data: { status: ReturnStatus.REFUNDED, refundAmount: refund.amount } });
        }
        await recordAudit(tx, ctx, { action: 'refund.complete', resourceType: 'Refund', resourceId: refundId, before: { status: refund.status }, after: { status: RefundStatus.COMPLETED, amount: refund.amount, providerReference } });
        return { refund: done, alreadyCompleted: false, notifyUser: { userId: order.userId, orderNumber: order.orderNumber, amount: refund.amount, currency: payment.currency, orderId: order.id } };
      },
      { timeout: 15_000 },
    );

    if (outcome.notifyUser) {
      const n = outcome.notifyUser;
      await notify({
        userId: n.userId,
        type: NotificationType.ACCOUNT,
        title: `Reembolso efetuado — ${n.orderNumber}`,
        body: `Foi reembolsado o valor de ${formatMoney(n.amount, n.currency)}.`,
        data: { orderId: n.orderId, refundId },
        email: true,
      });
    }
    return { refund: outcome.refund, alreadyCompleted: outcome.alreadyCompleted };
  }

  async fail(ctx: AuditContext, refundId: string, reason: string) {
    const refund = await prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw Errors.notFound('Refund');
    if (refund.status === RefundStatus.COMPLETED) throw Errors.unprocessable('REFUND_ALREADY_COMPLETED', 'Refund is already completed');
    return prisma.$transaction(async (tx) => {
      const r = await tx.refund.update({ where: { id: refundId }, data: { status: RefundStatus.FAILED, reason: `${refund.reason ?? ''} | FAILED: ${reason}`.slice(0, 300) } });
      await recordAudit(tx, ctx, { action: 'refund.fail', resourceType: 'Refund', resourceId: refundId, before: { status: refund.status }, after: { status: RefundStatus.FAILED, reason } });
      return r;
    });
  }
}
