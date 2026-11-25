import { z } from 'zod';
import { InventoryMovementType, NotificationType, OrderStatus, PaymentStatus, prisma, type Prisma, ReturnStatus } from '../../db/client';
import { recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { notify } from '../../utils/notifications';
import { pageMeta, paginationQuery, toSkipTake } from '../../utils/pagination';
import { refreshManyProductAggregates } from '../products/aggregates';
import { notifyBackInStock, restock } from '../products/inventory.service';
import { getSetting } from '../products/storefront/settings.service';
import type { StorageProvider } from '../uploads/storage/storage.provider';
import { addHistory, lockOrder } from './order-lifecycle';
import { assertTransition } from './order-state';
import { RefundsService } from './payments/refunds.service';

// ------------------------------------------------------------------ schemas
const evidenceKey = z.string().regex(/^returns\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/, 'Invalid evidence key');

export const createReturnBody = z.object({
  reason: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).optional(),
  items: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(50)
    .refine((a) => new Set(a.map((i) => i.orderItemId)).size === a.length, 'Duplicate items'),
  evidence: z.array(z.object({ storageKey: evidenceKey })).max(8).default([]),
});

export const listReturnsQuery = paginationQuery.extend({ status: z.nativeEnum(ReturnStatus).optional() });
export const adminListReturnsQuery = listReturnsQuery.extend({ search: z.string().trim().max(100).optional() });

export const approveReturnBody = z.object({ pickupAt: z.coerce.date().optional(), note: z.string().trim().max(300).optional() });
export const rejectReturnBody = z.object({ reason: z.string().trim().min(3).max(300) });
export const receiveReturnBody = z.object({
  items: z
    .array(
      z.object({
        returnItemId: z.string().uuid(),
        condition: z.string().trim().min(2).max(80),
        /** true => volta ao stock vendável; false => fica registado como danificado. */
        restock: z.boolean(),
      }),
    )
    .min(1),
});
export const refundReturnBody = z.object({
  /** Por omissão: valor pago pelos itens devolvidos (após descontos). */
  amount: z.number().int().positive().optional(),
  includeShipping: z.boolean().default(false),
});

type CreateReturnInput = z.infer<typeof createReturnBody>;

/** Devoluções com pedido aberto (impede pedidos duplicados para o mesmo pedido). */
const OPEN: ReturnStatus[] = [ReturnStatus.REQUESTED, ReturnStatus.UNDER_REVIEW, ReturnStatus.APPROVED, ReturnStatus.RECEIVED];
/** Devoluções que "ocupam" unidades do item (não contam rejeitadas/canceladas). */
const COUNTING: ReturnStatus[] = [...OPEN, ReturnStatus.REFUNDED];

/** Transições válidas da devolução. */
export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  REQUESTED: [ReturnStatus.UNDER_REVIEW, ReturnStatus.APPROVED, ReturnStatus.REJECTED, ReturnStatus.CANCELLED],
  UNDER_REVIEW: [ReturnStatus.APPROVED, ReturnStatus.REJECTED, ReturnStatus.CANCELLED],
  APPROVED: [ReturnStatus.RECEIVED, ReturnStatus.CANCELLED],
  RECEIVED: [ReturnStatus.REFUNDED],
  REJECTED: [],
  REFUNDED: [],
  CANCELLED: [],
};

export function assertReturnTransition(from: ReturnStatus, to: ReturnStatus) {
  if (!RETURN_TRANSITIONS[from].includes(to)) {
    throw Errors.unprocessable('INVALID_RETURN_TRANSITION', `Cannot change return from ${from} to ${to}`, { from, to, allowed: RETURN_TRANSITIONS[from] });
  }
}

const detailInclude = {
  items: { include: { orderItem: { select: { id: true, productName: true, sku: true, variantName: true, imageUrl: true, quantity: true, unitPrice: true, lineTotal: true } } } },
  order: { select: { id: true, orderNumber: true, status: true, deliveredAt: true, grandTotal: true, shippingTotal: true, currency: true } },
  refunds: { select: { id: true, amount: true, status: true, createdAt: true } },
} satisfies Prisma.ReturnRequestInclude;

/**
 * Devoluções: REQUESTED → UNDER_REVIEW → APPROVED → RECEIVED → REFUNDED
 *             (REJECTED / CANCELLED como saídas). O pedido acompanha:
 *             DELIVERED → RETURN_REQUESTED → RETURNED → REFUNDED (ou volta a DELIVERED).
 */
export class ReturnsService {
  private readonly refunds = new RefundsService();
  constructor(private readonly storage: StorageProvider) {}

  // ------------------------------------------------------------------ cliente
  async create(userId: string, orderId: string, input: CreateReturnInput) {
    const cfg = await getSetting('returns');
    if (!cfg.enabled) throw Errors.unprocessable('RETURNS_DISABLED', 'Returns are not available');
    if (!cfg.reasons.includes(input.reason)) throw Errors.badRequest('INVALID_RETURN_REASON', 'Choose one of the available reasons', { reasons: cfg.reasons });

    const result = await prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.userId !== userId) throw Errors.notFound('Order');
      if (order.status !== OrderStatus.DELIVERED) throw Errors.unprocessable('ORDER_NOT_RETURNABLE', 'Only delivered orders can be returned');
      const delivered = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { deliveredAt: true } });
      const deadline = new Date((delivered.deliveredAt ?? new Date()).getTime() + cfg.windowDays * 86_400_000);
      if (new Date() > deadline) throw Errors.unprocessable('RETURN_WINDOW_EXPIRED', `Returns must be requested within ${cfg.windowDays} days of delivery`, { deadline });

      const open = await tx.returnRequest.count({ where: { orderId, status: { in: OPEN } } });
      if (open) throw Errors.conflict('RETURN_ALREADY_OPEN', 'There is already an open return for this order');

      // Quantidade devolvível = comprada − já devolvida/em devolução.
      const already = await tx.returnItem.groupBy({ by: ['orderItemId'], where: { returnRequest: { orderId, status: { in: COUNTING } } }, _sum: { quantity: true } });
      const used = new Map(already.map((a) => [a.orderItemId, a._sum.quantity ?? 0]));
      for (const it of input.items) {
        const oi = order.items.find((i) => i.id === it.orderItemId);
        if (!oi) throw Errors.badRequest('ITEM_NOT_IN_ORDER', 'Item does not belong to this order', { orderItemId: it.orderItemId });
        const remaining = oi.quantity - (used.get(oi.id) ?? 0);
        if (it.quantity > remaining) throw Errors.unprocessable('RETURN_QUANTITY_EXCEEDED', `Only ${remaining} unit(s) of ${oi.sku} can be returned`, { orderItemId: oi.id, remaining });
      }

      const rr = await tx.returnRequest.create({
        data: {
          orderId,
          userId,
          reason: input.reason,
          description: input.description,
          evidenceUrls: input.evidence.map((e) => this.storage.publicUrl(e.storageKey)),
          items: { create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
        },
      });
      assertTransition(order.status, OrderStatus.RETURN_REQUESTED);
      await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.RETURN_REQUESTED, requiresAttention: true } });
      await addHistory(tx, orderId, order.status, OrderStatus.RETURN_REQUESTED, `Return requested: ${input.reason}`, userId);
      return rr;
    });
    return this.getMine(userId, result.id);
  }

  async listMine(userId: string, q: z.infer<typeof listReturnsQuery>) {
    const where: Prisma.ReturnRequestWhereInput = { userId, ...(q.status ? { status: q.status } : {}) };
    const [total, items] = await prisma.$transaction([
      prisma.returnRequest.count({ where }),
      prisma.returnRequest.findMany({ where, include: detailInclude, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async getMine(userId: string, id: string) {
    const rr = await prisma.returnRequest.findFirst({ where: { id, userId }, include: detailInclude });
    if (!rr) throw Errors.notFound('Return request');
    const { reviewedById: _r, ...pub } = rr;
    return pub;
  }

  async cancelMine(userId: string, id: string) {
    await this.transition(id, ReturnStatus.CANCELLED, { userId, orderStatus: OrderStatus.DELIVERED, note: 'Return cancelled by customer', actorId: userId });
    return this.getMine(userId, id);
  }

  // ------------------------------------------------------------------ núcleo
  /** Muda o estado da devolução (e opcionalmente do pedido) com lock e validação. */
  private async transition(
    id: string,
    to: ReturnStatus,
    opts: { userId?: string; orderStatus?: OrderStatus; note?: string; actorId?: string; data?: Prisma.ReturnRequestUpdateInput; ctx?: AuditContext },
    extra?: (tx: Prisma.TransactionClient, rr: Prisma.ReturnRequestGetPayload<{ include: { items: { include: { orderItem: true } } } }>) => Promise<void>,
  ) {
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "return_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const rr = await tx.returnRequest.findUnique({ where: { id }, include: { items: { include: { orderItem: true } } } });
        if (!rr || (opts.userId && rr.userId !== opts.userId)) throw Errors.notFound('Return request');
        assertReturnTransition(rr.status, to);
        if (extra) await extra(tx, rr);
        await tx.returnRequest.update({ where: { id }, data: { ...opts.data, status: to } });

        if (opts.orderStatus) {
          const order = await lockOrder(tx, rr.orderId);
          if (order && order.status !== opts.orderStatus) {
            assertTransition(order.status, opts.orderStatus);
            await tx.order.update({
              where: { id: order.id },
              data: { status: opts.orderStatus, ...(opts.orderStatus === OrderStatus.DELIVERED ? { requiresAttention: false } : {}) },
            });
            await addHistory(tx, order.id, order.status, opts.orderStatus, opts.note, opts.actorId);
          }
        }
        if (opts.ctx) {
          await recordAudit(tx, opts.ctx, { action: `return.${to.toLowerCase()}`, resourceType: 'ReturnRequest', resourceId: id, before: { status: rr.status }, after: { status: to, note: opts.note } });
        }
        return rr;
      },
      { timeout: 15_000 },
    );
  }

  private async notifyCustomer(id: string, title: string, body: string) {
    const rr = await prisma.returnRequest.findUnique({ where: { id }, select: { userId: true, orderId: true, order: { select: { orderNumber: true } } } });
    if (rr) await notify({ userId: rr.userId, type: NotificationType.ACCOUNT, title: `${title} — ${rr.order.orderNumber}`, body, data: { returnId: id, orderId: rr.orderId }, email: true });
  }

  // ------------------------------------------------------------------ admin
  async adminList(q: z.infer<typeof adminListReturnsQuery>) {
    const where: Prisma.ReturnRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? { OR: [{ order: { orderNumber: { contains: q.search, mode: 'insensitive' } } }, { user: { email: { contains: q.search, mode: 'insensitive' } } }] }
        : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.returnRequest.count({ where }),
      prisma.returnRequest.findMany({ where, include: { ...detailInclude, user: { select: { id: true, name: true, email: true, phone: true } } }, orderBy: { createdAt: 'asc' }, ...toSkipTake(q) }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async adminGet(id: string) {
    const rr = await prisma.returnRequest.findUnique({ where: { id }, include: { ...detailInclude, user: { select: { id: true, name: true, email: true, phone: true } } } });
    if (!rr) throw Errors.notFound('Return request');
    return rr;
  }

  async startReview(ctx: AuditContext, id: string) {
    await this.transition(id, ReturnStatus.UNDER_REVIEW, { ctx, actorId: ctx.actorId, data: { reviewedById: ctx.actorId, reviewedAt: new Date() } });
    return this.adminGet(id);
  }

  async approve(ctx: AuditContext, id: string, input: z.infer<typeof approveReturnBody>) {
    await this.transition(id, ReturnStatus.APPROVED, { ctx, actorId: ctx.actorId, note: input.note, data: { reviewedById: ctx.actorId, reviewedAt: new Date(), pickupAt: input.pickupAt } });
    await this.notifyCustomer(id, 'Devolução aprovada', input.pickupAt ? `A recolha está agendada para ${input.pickupAt.toLocaleString('pt-PT', { timeZone: 'Africa/Maputo' })}.` : 'A nossa equipa vai contactá-lo para a recolha.');
    return this.adminGet(id);
  }

  async reject(ctx: AuditContext, id: string, reason: string) {
    await this.transition(id, ReturnStatus.REJECTED, {
      ctx,
      actorId: ctx.actorId,
      note: `Return rejected: ${reason}`,
      orderStatus: OrderStatus.DELIVERED,
      data: { reviewedById: ctx.actorId, reviewedAt: new Date(), rejectionReason: reason },
    });
    await this.notifyCustomer(id, 'Devolução recusada', reason);
    return this.adminGet(id);
  }

  async adminCancel(ctx: AuditContext, id: string) {
    await this.transition(id, ReturnStatus.CANCELLED, { ctx, actorId: ctx.actorId, orderStatus: OrderStatus.DELIVERED, note: 'Return cancelled by store' });
    return this.adminGet(id);
  }

  /** Receção dos artigos: repõe stock vendável ou regista como danificado. */
  async receive(ctx: AuditContext, id: string, input: z.infer<typeof receiveReturnBody>) {
    const restocked: string[] = [];
    const productIds = new Set<string>();
    await this.transition(
      id,
      ReturnStatus.RECEIVED,
      { ctx, actorId: ctx.actorId, orderStatus: OrderStatus.RETURNED, note: 'Returned items received', data: { receivedAt: new Date() } },
      async (tx, rr) => {
        const byId = new Map(input.items.map((i) => [i.returnItemId, i]));
        if (rr.items.some((i) => !byId.has(i.id)) || byId.size !== rr.items.length) {
          throw Errors.badRequest('RETURN_ITEMS_MISMATCH', 'Inform the condition of every returned item');
        }
        for (const item of rr.items) {
          const decision = byId.get(item.id)!;
          await tx.returnItem.update({ where: { id: item.id }, data: { condition: decision.condition } });
          const variantId = item.orderItem.variantId;
          if (!variantId) continue;
          if (item.orderItem.productId) productIds.add(item.orderItem.productId);
          if (decision.restock) {
            await restock(tx, { variantId, quantity: item.quantity }, { type: InventoryMovementType.RETURN, referenceType: 'RETURN', referenceId: id, reason: `Devolução (${decision.condition})`, actorId: ctx.actorId });
            restocked.push(variantId);
          }
          // Não vendável: não entra no stock disponível; fica a evidência na devolução + auditoria.
          if (item.orderItem.productId) {
            await tx.$executeRaw`UPDATE "products" SET "soldCount" = GREATEST("soldCount" - ${item.quantity}, 0) WHERE "id" = ${item.orderItem.productId}::uuid`;
          }
        }
      },
    );
    await refreshManyProductAggregates(productIds);
    for (const v of restocked) await notifyBackInStock(v);
    await this.notifyCustomer(id, 'Devolução recebida', 'Recebemos os artigos devolvidos. O reembolso será processado em breve.');
    return this.adminGet(id);
  }

  /** Valor por omissão: total pago pelas unidades devolvidas (já com descontos/IVA). */
  static defaultRefundAmount(items: Array<{ quantity: number; orderItem: { quantity: number; lineTotal: number } }>) {
    return items.reduce((sum, i) => sum + Math.round((i.orderItem.lineTotal * i.quantity) / i.orderItem.quantity), 0);
  }

  /** Cria e processa o reembolso da devolução (idempotente por devolução). */
  async refund(ctx: AuditContext, id: string, input: z.infer<typeof refundReturnBody> & { providerReference?: string }) {
    const rr = await prisma.returnRequest.findUnique({
      where: { id },
      include: { items: { include: { orderItem: { select: { quantity: true, lineTotal: true } } } }, order: { select: { shippingTotal: true, payments: { where: { status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } }, orderBy: { paidAt: 'desc' } } } } },
    });
    if (!rr) throw Errors.notFound('Return request');
    if (rr.status !== ReturnStatus.RECEIVED) throw Errors.unprocessable('RETURN_NOT_RECEIVED', 'Items must be received before refunding');
    const payment = rr.order.payments[0];
    if (!payment) throw Errors.unprocessable('NO_PAID_PAYMENT', 'This order has no paid payment to refund');

    const amount = input.amount ?? ReturnsService.defaultRefundAmount(rr.items) + (input.includeShipping ? rr.order.shippingTotal : 0);
    const { refund } = await this.refunds.create(ctx, { paymentId: payment.id, amount, reason: `Return ${rr.reason}`, returnRequestId: id }, `return:${id}`);
    const result = await this.refunds.process(ctx, refund.id, { providerReference: input.providerReference, note: 'Return refund' });
    return { refund: result.refund, return: await this.adminGet(id) };
  }
}
