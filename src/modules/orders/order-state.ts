import { OrderStatus } from '../../db/client';
import { Errors } from '../../utils/errors';

/** Máquina de estados do pedido — única fonte das transições válidas. */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  CONFIRMED: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  PROCESSING: [OrderStatus.PACKED, OrderStatus.CANCELLED],
  PACKED: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  SHIPPED: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  OUT_FOR_DELIVERY: [OrderStatus.DELIVERED],
  DELIVERED: [OrderStatus.RETURN_REQUESTED],
  RETURN_REQUESTED: [OrderStatus.RETURNED, OrderStatus.DELIVERED],
  RETURNED: [OrderStatus.REFUNDED],
  CANCELLED: [OrderStatus.REFUNDED],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw Errors.unprocessable('INVALID_STATUS_TRANSITION', `Cannot change order status from ${from} to ${to}`, {
      from,
      to,
      allowed: ORDER_TRANSITIONS[from],
    });
  }
}

/** O cliente só pode cancelar antes de a loja começar a preparar o pedido. */
export const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

/** Estados em que o stock já saiu do inventário (cancelar => repor stock). */
export const STOCK_COMMITTED: readonly OrderStatus[] = [OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.PACKED];
