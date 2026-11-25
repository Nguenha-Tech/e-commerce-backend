import { randomInt } from 'node:crypto';
import {
  InventoryMovementType,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReservationStatus,
  type Db,
} from '../../db/client';
import { commitSale, releaseReservedStock, restock } from '../products/inventory.service';
import { revertCoupon } from './coupons';
import { assertTransition } from './order-state';

/*
 * Operações de ciclo de vida do pedido que mexem em stock/pagamentos.
 * Todas recebem a transação (`tx`) e assumem que o pedido foi bloqueado com lockOrder().
 */

export const lifecycleInclude = {
  items: { select: { id: true, variantId: true, productId: true, quantity: true, sku: true } },
  reservations: true,
  payments: true,
} satisfies Prisma.OrderInclude;

export type LockedOrder = Prisma.OrderGetPayload<{ include: typeof lifecycleInclude }>;

/** SELECT … FOR UPDATE: serializa webhook, job de expiração e ações de admin sobre o mesmo pedido. */
export async function lockOrder(tx: Db, orderId: string): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.order.findUnique({ where: { id: orderId }, include: lifecycleInclude });
}

export async function addHistory(tx: Db, orderId: string, from: OrderStatus | null, to: OrderStatus, note?: string, actorId?: string) {
  await tx.orderStatusHistory.create({ data: { orderId, fromStatus: from, toStatus: to, note: note?.slice(0, 500), changedById: actorId } });
}

/**
 * Converte reservas em saída de stock (venda). Usa SAVEPOINT: se alguma linha falhar
 * (reserva expirou e o stock foi vendido entretanto), nada é aplicado e devolve as falhas.
 */
export async function commitOrderStock(tx: Db, order: LockedOrder, actorId?: string): Promise<{ ok: true } | { ok: false; failedSkus: string[] }> {
  await tx.$executeRaw`SAVEPOINT commit_stock`;
  const failed: string[] = [];
  const items = [...order.items].filter((i) => i.variantId).sort((a, b) => a.variantId!.localeCompare(b.variantId!));

  for (const item of items) {
    const reservation = order.reservations.find((r) => r.variantId === item.variantId && r.status === ReservationStatus.ACTIVE);
    const ok = await commitSale(tx, { variantId: item.variantId!, quantity: item.quantity, sku: item.sku }, Boolean(reservation), {
      referenceType: 'ORDER',
      referenceId: order.id,
      reason: `Venda ${order.orderNumber}`,
      actorId,
    });
    if (!ok) {
      failed.push(item.sku);
      continue;
    }
    if (reservation) {
      await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.CONSUMED } });
    } else {
      await tx.stockReservation.create({
        data: { orderId: order.id, variantId: item.variantId!, quantity: item.quantity, status: ReservationStatus.CONSUMED, expiresAt: new Date() },
      });
    }
    if (item.productId) await tx.product.update({ where: { id: item.productId }, data: { soldCount: { increment: item.quantity } } });
  }

  if (failed.length) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT commit_stock`;
    return { ok: false, failedSkus: failed };
  }
  await tx.$executeRaw`RELEASE SAVEPOINT commit_stock`;
  return { ok: true };
}

/** Liberta reservas ainda ativas (pagamento falhou/expirou, cancelamento antes do pagamento). */
async function releaseActiveReservations(tx: Db, order: LockedOrder, status: ReservationStatus) {
  for (const r of order.reservations.filter((x) => x.status === ReservationStatus.ACTIVE)) {
    await releaseReservedStock(tx, { variantId: r.variantId, quantity: r.quantity });
    await tx.stockReservation.update({ where: { id: r.id }, data: { status } });
  }
}

/** Repõe stock já vendido (cancelamento depois de confirmado). Idempotente via estado da reserva. */
async function restockConsumed(tx: Db, order: LockedOrder, actorId?: string) {
  for (const r of order.reservations.filter((x) => x.status === ReservationStatus.CONSUMED)) {
    await restock(tx, { variantId: r.variantId, quantity: r.quantity }, {
      type: InventoryMovementType.CANCELLATION_RESTOCK,
      referenceType: 'ORDER',
      referenceId: order.id,
      reason: `Cancelamento ${order.orderNumber}`,
      actorId,
    });
    await tx.stockReservation.update({ where: { id: r.id }, data: { status: ReservationStatus.RELEASED } });
    const item = order.items.find((i) => i.variantId === r.variantId);
    if (item?.productId) await tx.product.update({ where: { id: item.productId }, data: { soldCount: { decrement: r.quantity } } });
  }
}

export interface CancelOptions {
  reason: string;
  actorId?: string;
  /** EXPIRED quando cancelado pelo job de expiração. */
  reservationStatus?: ReservationStatus;
}

/** Cancela: liberta/repõe stock, devolve o cupão, cancela pagamentos pendentes e cria reembolso se já pago. */
export async function cancelOrderTx(tx: Db, order: LockedOrder, opts: CancelOptions) {
  assertTransition(order.status, OrderStatus.CANCELLED);

  await releaseActiveReservations(tx, order, opts.reservationStatus ?? ReservationStatus.RELEASED);
  await restockConsumed(tx, order, opts.actorId);
  await revertCoupon(tx, order.id);

  let requiresAttention = order.requiresAttention;
  for (const p of order.payments) {
    if (p.status === PaymentStatus.PENDING || p.status === PaymentStatus.PROCESSING) {
      await tx.payment.update({ where: { id: p.id }, data: { status: PaymentStatus.CANCELLED } });
    } else if (p.status === PaymentStatus.PAID) {
      // Pedido já pago: reembolso fica pendente para processamento pelo financeiro.
      await tx.refund.upsert({
        where: { idempotencyKey: `refund:cancel:${order.id}:${p.id}` },
        update: {},
        create: {
          paymentId: p.id,
          amount: p.amount - p.refundedAmount,
          reason: `Order cancelled: ${opts.reason}`.slice(0, 300),
          idempotencyKey: `refund:cancel:${order.id}:${p.id}`,
          createdById: opts.actorId,
        },
      });
      requiresAttention = true;
    }
  }

  await tx.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: opts.reason.slice(0, 300),
      requiresAttention,
      ...(order.paymentStatus === PaymentStatus.PENDING || order.paymentStatus === PaymentStatus.PROCESSING ? { paymentStatus: PaymentStatus.CANCELLED } : {}),
    },
  });
  await addHistory(tx, order.id, order.status, OrderStatus.CANCELLED, opts.reason, opts.actorId);
}

export async function confirmOrderTx(tx: Db, order: LockedOrder, note: string, actorId?: string) {
  assertTransition(order.status, OrderStatus.CONFIRMED);
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED, confirmedAt: new Date() } });
  await addHistory(tx, order.id, order.status, OrderStatus.CONFIRMED, note, actorId);
}

/** EL + AAMMDD + 6 caracteres aleatórios (sem caracteres ambíguos). */
export function generateOrderNumber(now = new Date()): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += alphabet[randomInt(alphabet.length)];
  return `EL${date}${suffix}`;
}
