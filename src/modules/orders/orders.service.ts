import { env } from '../../config/env';
import {
  NotificationType,
  OrderStatus,
  PaymentMethodType,
  PaymentStatus,
  PaymentTransactionType,
  prisma,
  Prisma,
  ReservationStatus,
  ShipmentStatus,
} from '../../db/client';
import { recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { formatMoney } from '../../utils/money';
import { notify } from '../../utils/notifications';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import { refreshManyProductAggregates } from '../products/aggregates';
import { reserveStock } from '../products/inventory.service';
import { taxConfig } from './cart.service';
import { loadCoupon, redeemCoupon } from './coupons';
import { resolveLines, type RequestedItem, type ResolvedLine } from './lines';
import {
  addHistory,
  cancelOrderTx,
  commitOrderStock,
  confirmOrderTx,
  generateOrderNumber,
  lockOrder,
} from './order-lifecycle';
import { assertTransition, CUSTOMER_CANCELLABLE } from './order-state';
import type { NextAction } from './payments/payment.provider';
import { PaymentsService } from './payments/payments.service';
import { getPaymentProvider } from './payments/providers';
import { calculateTotals, type CouponRule, type PricingResult } from './pricing';
import { ShippingService, type ShippingOption } from './shipping.service';

export interface CheckoutInput {
  addressId?: string;
  shippingMethodCode: string;
  paymentMethodCode: string;
  couponCode?: string;
  customerNote?: string;
  /** "Comprar agora": itens diretos em vez do carrinho. */
  items?: RequestedItem[];
  /** Total que o cliente viu; se mudou, o pedido é recusado com PRICE_CHANGED. */
  expectedTotal?: number;
}

const isUniqueViolation = (err: unknown, field?: string) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  err.code === 'P2002' &&
  (!field || JSON.stringify(err.meta ?? {}).includes(field));

const customerOrderInclude = {
  items: {
    select: {
      id: true, productId: true, variantId: true, productName: true, productSlug: true, sku: true, variantName: true,
      variantOptions: true, imageUrl: true, originalUnitPrice: true, unitPrice: true, quantity: true, couponDiscount: true,
      taxTotal: true, lineTotal: true,
    },
  },
  statusHistory: { select: { fromStatus: true, toStatus: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
  payments: { select: { id: true, methodCode: true, status: true, amount: true, currency: true, paidAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
  shipments: {
    select: { id: true, carrier: true, trackingCode: true, trackingUrl: true, status: true, shippedAt: true, deliveredAt: true, events: { orderBy: { occurredAt: 'desc' } } },
  },
} satisfies Prisma.OrderInclude;

type CustomerOrderRow = Prisma.OrderGetPayload<{ include: typeof customerOrderInclude }>;

function toCustomerOrder(o: CustomerOrderRow) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    totals: {
      subtotal: o.subtotal,
      productDiscount: o.productDiscount,
      couponDiscount: o.couponDiscount,
      shipping: o.shippingTotal,
      tax: o.taxTotal,
      taxIncluded: o.taxIncluded,
      total: o.grandTotal,
    },
    couponCode: o.couponCode,
    shipping: { method: o.shippingMethodName, code: o.shippingMethodCode, address: o.shippingAddress, trackingCode: o.trackingCode },
    paymentMethod: { code: o.paymentMethodCode, type: o.paymentMethodType },
    customerNote: o.customerNote,
    cancelReason: o.cancelReason,
    items: o.items,
    statusHistory: o.statusHistory,
    payments: o.payments,
    shipments: o.shipments,
    canCancel: CUSTOMER_CANCELLABLE.includes(o.status),
    placedAt: o.placedAt,
    confirmedAt: o.confirmedAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
  };
}

interface PreparedCheckout {
  lines: ResolvedLine[];
  fromCart: { cartId: string } | null;
  address: Prisma.InputJsonValue | null;
  shipping: ShippingOption;
  payment: { id: string; code: string; type: PaymentMethodType; provider: string };
  coupon: CouponRule | null;
  totals: PricingResult;
  currency: string;
}

/** Estados controlados pelos fluxos de devolução/reembolso, não pela mudança manual de estado. */
const MANAGED_BY_RETURNS: OrderStatus[] = [OrderStatus.RETURN_REQUESTED, OrderStatus.RETURNED, OrderStatus.REFUNDED];

export class OrdersService {
  private shipping = new ShippingService();
  private payments = new PaymentsService();

  // ======================================================================= checkout
  /** Toda a validação do checkout (produto, variante, preço, stock, cupão, entrega, pagamento). */
  private async prepare(userId: string, input: CheckoutInput, strict: boolean): Promise<PreparedCheckout> {
    let items = input.items;
    let fromCart: PreparedCheckout['fromCart'] = null;
    let cartCoupon: string | null = null;
    if (!items) {
      const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: true } });
      items = cart?.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) ?? [];
      fromCart = cart ? { cartId: cart.id } : null;
      cartCoupon = cart?.couponCode ?? null;
    }
    if (items.length === 0) throw Errors.unprocessable('CART_EMPTY', 'Your cart is empty');

    const lines = await resolveLines(items);
    const missing = items.filter((i) => !lines.some((l) => l.variantId === i.variantId));
    const issues = [
      ...missing.map((m) => ({ variantId: m.variantId, code: 'UNAVAILABLE', message: 'Product not found' })),
      ...lines.filter((l) => l.issue).map((l) => ({ variantId: l.variantId, sku: l.sku, ...l.issue! })),
    ];
    if (strict && issues.length) {
      const stockOnly = issues.every((i) => i.code === 'INSUFFICIENT_STOCK');
      throw stockOnly
        ? Errors.conflict('INSUFFICIENT_STOCK', 'Some items do not have enough stock', { issues })
        : Errors.conflict('CART_HAS_ISSUES', 'Some items are no longer available', { issues });
    }
    const currencies = new Set(lines.map((l) => l.currency));
    if (currencies.size > 1) throw Errors.unprocessable('MIXED_CURRENCIES', 'All items must use the same currency');

    // Endereço (snapshot) — obrigatório exceto levantamento na loja.
    let addressSnapshot: Prisma.InputJsonValue | null = null;
    let addressForShipping: { country: string; province: string; city: string } | null = null;
    if (input.addressId) {
      const a = await prisma.address.findFirst({ where: { id: input.addressId, userId, deletedAt: null } });
      if (!a) throw Errors.notFound('Address');
      addressForShipping = a;
      addressSnapshot = {
        recipientName: a.recipientName, phone: a.phone, country: a.country, province: a.province, city: a.city,
        neighborhood: a.neighborhood, street: a.street, number: a.number, reference: a.reference, postalCode: a.postalCode, type: a.type,
      };
    }

    const valid = lines.filter((l) => !l.issue);
    const subtotal = valid.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    const shipping = await this.shipping.quote(input.shippingMethodCode, addressForShipping, {
      subtotal,
      weightGrams: valid.reduce((s, l) => s + l.weightGrams, 0),
    });

    const method = await prisma.paymentMethod.findFirst({ where: { code: input.paymentMethodCode, isActive: true } });
    if (!method) throw Errors.unprocessable('PAYMENT_METHOD_INVALID', 'Payment method is not available');
    getPaymentProvider(method.provider); // garante que o provider existe

    const couponCode = input.couponCode ?? cartCoupon;
    const coupon = couponCode ? await loadCoupon(couponCode, userId) : null;

    const totals = calculateTotals({ lines: valid, coupon, shippingPrice: shipping.price, tax: taxConfig() });
    if (coupon && totals.coupon && !totals.coupon.applied) {
      if (strict || input.couponCode) {
        throw Errors.unprocessable(
          totals.coupon.reason === 'MIN_ORDER_NOT_MET' ? 'COUPON_MIN_ORDER_NOT_MET' : 'COUPON_NOT_APPLICABLE',
          totals.coupon.reason === 'MIN_ORDER_NOT_MET' ? 'Order does not reach the coupon minimum amount' : 'Coupon does not apply to these items',
          { minOrderAmount: coupon.minOrderAmount },
        );
      }
    }

    return {
      lines: valid,
      fromCart,
      address: addressSnapshot,
      shipping,
      payment: { id: method.id, code: method.code, type: method.type, provider: method.provider },
      coupon: totals.coupon?.applied ? coupon : null,
      totals,
      currency: valid[0]?.currency ?? env.DEFAULT_CURRENCY,
    };
  }

  /** Resumo calculado no servidor (passo "Resumo" do checkout). Não reserva nada. */
  async quote(userId: string, input: CheckoutInput) {
    const p = await this.prepare(userId, input, false);
    return {
      currency: p.currency,
      items: p.totals.lines.map((l) => {
        const line = p.lines.find((x) => x.variantId === l.variantId)!;
        return { variantId: l.variantId, name: line.productName, sku: line.sku, variantName: line.variantName, image: line.imageUrl, quantity: l.quantity, unitPrice: l.unitPrice, couponDiscount: l.couponDiscount, lineTotal: l.lineTotal };
      }),
      shipping: { code: p.shipping.code, name: p.shipping.name, price: p.totals.shippingTotal, estimatedDays: p.shipping.estimatedDays },
      payment: { code: p.payment.code, type: p.payment.type },
      coupon: p.totals.coupon,
      totals: {
        subtotal: p.totals.subtotal,
        productDiscount: p.totals.productDiscount,
        couponDiscount: p.totals.couponDiscount,
        shipping: p.totals.shippingTotal,
        tax: p.totals.taxTotal,
        taxIncluded: p.totals.taxIncluded,
        total: p.totals.grandTotal,
      },
    };
  }

  /**
   * Cria o pedido de forma atómica e idempotente.
   * Idempotency-Key + unique(userId, key): repetir o pedido devolve o mesmo pedido.
   */
  async placeOrder(userId: string, input: CheckoutInput, idempotencyKey: string) {
    const existing = await prisma.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: { id: true } });
    if (existing) return { created: false, ...(await this.replay(userId, existing.id)) };

    const p = await this.prepare(userId, input, true);
    if (input.expectedTotal !== undefined && input.expectedTotal !== p.totals.grandTotal) {
      throw Errors.conflict('PRICE_CHANGED', 'Prices changed since you reviewed your order', { expected: input.expectedTotal, actual: p.totals.grandTotal });
    }

    const isCod = p.payment.type === PaymentMethodType.CASH_ON_DELIVERY;
    let orderId: string;
    let paymentId: string;
    try {
      ({ orderId, paymentId } = await prisma.$transaction(
        async (tx) => {
          // 1) Reserva atómica de stock (lança INSUFFICIENT_STOCK e reverte tudo).
          await reserveStock(tx, p.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, sku: l.sku })));

          // 2) Pedido com snapshot completo.
          const order = await tx.order.create({
            data: {
              orderNumber: generateOrderNumber(),
              userId,
              currency: p.currency,
              subtotal: p.totals.subtotal,
              productDiscount: p.totals.productDiscount,
              couponDiscount: p.totals.couponDiscount,
              shippingTotal: p.totals.shippingTotal ?? 0,
              taxTotal: p.totals.taxTotal,
              taxIncluded: p.totals.taxIncluded,
              grandTotal: p.totals.grandTotal,
              couponId: p.coupon?.id,
              couponCode: p.coupon?.code,
              shippingMethodId: p.shipping.id,
              shippingMethodCode: p.shipping.code,
              shippingMethodName: p.shipping.name,
              shippingAddress: p.address ?? Prisma.DbNull,
              paymentMethodCode: p.payment.code,
              paymentMethodType: p.payment.type,
              customerNote: input.customerNote,
              idempotencyKey,
              items: {
                create: p.totals.lines.map((l) => {
                  const line = p.lines.find((x) => x.variantId === l.variantId)!;
                  return {
                    productId: line.productId,
                    variantId: line.variantId,
                    productName: line.productName,
                    productSlug: line.productSlug,
                    sku: line.sku,
                    variantName: line.variantName,
                    variantOptions: line.options,
                    imageUrl: line.imageUrl,
                    categoryId: line.categoryId,
                    brandName: line.brandName,
                    originalUnitPrice: line.compareAtPrice,
                    unitPrice: l.unitPrice,
                    costPrice: line.costPrice,
                    quantity: l.quantity,
                    couponDiscount: l.couponDiscount,
                    taxTotal: l.taxAmount,
                    lineTotal: l.lineTotal,
                  };
                }),
              },
              statusHistory: { create: { fromStatus: null, toStatus: OrderStatus.PENDING, note: 'Order placed' } },
            },
          });

          await tx.stockReservation.createMany({
            data: p.lines.map((l) => ({
              orderId: order.id,
              variantId: l.variantId,
              quantity: l.quantity,
              status: ReservationStatus.ACTIVE,
              expiresAt: new Date(Date.now() + env.STOCK_RESERVATION_TTL_MINUTES * 60_000),
            })),
          });

          const payment = await tx.payment.create({
            data: {
              orderId: order.id,
              paymentMethodId: p.payment.id,
              methodCode: p.payment.code,
              provider: p.payment.provider,
              amount: p.totals.grandTotal,
              currency: p.currency,
              idempotencyKey: `order:${order.id}:initial`,
            },
          });

          if (p.coupon) await redeemCoupon(tx, p.coupon, userId, order.id, p.totals.couponDiscount);

          // 3) Pagamento na entrega: stock sai já e o pedido fica confirmado.
          if (isCod) {
            const locked = await lockOrder(tx, order.id);
            const stock = await commitOrderStock(tx, locked!);
            if (!stock.ok) throw Errors.conflict('INSUFFICIENT_STOCK', 'Some items do not have enough stock', { skus: stock.failedSkus });
            await confirmOrderTx(tx, locked!, 'Cash on delivery');
          }

          // 4) Limpa do carrinho apenas o que foi comprado.
          if (p.fromCart) {
            await tx.cartItem.deleteMany({ where: { cartId: p.fromCart.cartId, variantId: { in: p.lines.map((l) => l.variantId) } } });
            await tx.cart.update({ where: { id: p.fromCart.cartId }, data: { couponCode: null } });
          }
          return { orderId: order.id, paymentId: payment.id };
        },
        { timeout: 20_000, maxWait: 5_000 },
      ));
    } catch (err) {
      // Corrida com outro pedido igual (duplo clique / retry de rede): devolve o vencedor.
      if (isUniqueViolation(err, 'idempotencyKey')) {
        const winner = await prisma.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: { id: true } });
        if (winner) return { created: false, ...(await this.replay(userId, winner.id)) };
      }
      throw err;
    }

    await refreshManyProductAggregates(p.lines.map((l) => l.productId));
    const payment = await this.payments.initiate(paymentId);
    const order = await this.getMine(userId, orderId);

    await notify({
      userId,
      type: NotificationType.ORDER_CREATED,
      title: `Pedido ${order.orderNumber} recebido`,
      body: `Total: ${formatMoney(order.totals.total, order.currency)}. ${isCod ? 'Pagamento na entrega.' : 'Aguardamos a confirmação do pagamento.'}`,
      data: { orderId },
      email: true,
    });
    return { created: true, order, payment: { id: paymentId, ...payment } };
  }

  private async replay(userId: string, orderId: string) {
    const order = await this.getMine(userId, orderId);
    const latest = order.payments[0];
    const nextAction: NextAction = { type: 'NONE' };
    return { order, payment: latest ? { id: latest.id, status: latest.status, nextAction } : null };
  }

  // ======================================================================= cliente
  async listMine(userId: string, q: { page: number; limit: number; status?: OrderStatus }) {
    const where: Prisma.OrderWhereInput = { userId, ...(q.status ? { status: q.status } : {}) };
    const [total, rows] = await prisma.$transaction([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        select: {
          id: true, orderNumber: true, status: true, paymentStatus: true, currency: true, grandTotal: true, placedAt: true, trackingCode: true,
          items: { select: { productName: true, imageUrl: true, quantity: true }, take: 3 },
          _count: { select: { items: true } },
        },
        orderBy: { placedAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items: rows, meta: pageMeta(total, q) };
  }

  async getMine(userId: string, orderId: string) {
    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, include: customerOrderInclude });
    if (!order) throw Errors.notFound('Order');
    return toCustomerOrder(order);
  }

  async cancelMine(userId: string, orderId: string, reason: string) {
    const productIds = await prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.userId !== userId) throw Errors.notFound('Order');
      if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
        throw Errors.unprocessable('ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled. Please contact support.');
      }
      await cancelOrderTx(tx, order, { reason: `Customer: ${reason}`, actorId: userId });
      return order.items.map((i) => i.productId).filter((x): x is string => Boolean(x));
    });
    await refreshManyProductAggregates(productIds);
    await notify({ userId, type: NotificationType.ORDER_CANCELLED, title: 'Pedido cancelado', body: 'O seu pedido foi cancelado.', data: { orderId } });
    return this.getMine(userId, orderId);
  }

  // ======================================================================= admin
  async adminList(q: {
    page: number; limit: number; status?: OrderStatus; paymentStatus?: PaymentStatus; search?: string;
    from?: Date; to?: Date; requiresAttention?: boolean;
  }) {
    const where: Prisma.OrderWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
      ...(q.requiresAttention !== undefined ? { requiresAttention: q.requiresAttention } : {}),
      ...(q.from || q.to ? { placedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.search
        ? {
            OR: [
              { orderNumber: { contains: q.search, mode: 'insensitive' } },
              { user: { email: { contains: q.search, mode: 'insensitive' } } },
              { user: { name: { contains: q.search, mode: 'insensitive' } } },
              { trackingCode: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        select: {
          id: true, orderNumber: true, status: true, paymentStatus: true, paymentMethodCode: true, currency: true, grandTotal: true,
          shippingMethodName: true, requiresAttention: true, placedAt: true,
          user: { select: { id: true, name: true, email: true } },
          _count: { select: { items: true } },
        },
        orderBy: { placedAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async adminGet(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        ...customerOrderInclude,
        items: true, // inclui custo para margens
        statusHistory: { orderBy: { createdAt: 'asc' } },
        payments: { include: { transactions: { orderBy: { createdAt: 'asc' } }, refunds: true }, orderBy: { createdAt: 'desc' } },
        reservations: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    if (!order) throw Errors.notFound('Order');
    return order;
  }

  async adminUpdateStatus(
    ctx: AuditContext,
    orderId: string,
    input: { status: OrderStatus; note?: string; trackingCode?: string; carrier?: string; trackingUrl?: string; location?: string },
  ) {
    const result = await prisma.$transaction(
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        if (!order) throw Errors.notFound('Order');
        const from = order.status;
        const to = input.status;

        if (MANAGED_BY_RETURNS.includes(to)) {
          // Devoluções e reembolsos têm fluxo próprio (stock, reembolso, notificações).
          throw Errors.unprocessable('USE_RETURNS_FLOW', `Status ${to} is set through the returns/refunds endpoints`);
        }
        if (to === OrderStatus.CANCELLED) {
          await cancelOrderTx(tx, order, { reason: input.note ?? 'Cancelled by store', actorId: ctx.actorId });
        } else {
          assertTransition(from, to);
          const now = new Date();
          const data: Prisma.OrderUpdateInput = { status: to };

          if (to === OrderStatus.CONFIRMED) {
            if (order.paymentStatus !== PaymentStatus.PAID) {
              throw Errors.unprocessable('PAYMENT_NOT_CONFIRMED', 'Order can only be confirmed after payment');
            }
            const stock = await commitOrderStock(tx, order, ctx.actorId);
            if (!stock.ok) throw Errors.conflict('INSUFFICIENT_STOCK', 'Not enough stock to confirm this order', { skus: stock.failedSkus });
            data.confirmedAt = now;
            data.requiresAttention = false;
          }

          if (to === OrderStatus.SHIPPED) {
            const method = order.shippingMethodId
              ? await tx.shippingMethod.findUnique({ where: { id: order.shippingMethodId }, select: { type: true } })
              : null;
            if (!input.trackingCode && method?.type !== 'PICKUP') {
              throw Errors.badRequest('TRACKING_CODE_REQUIRED', 'A tracking code is required to ship');
            }
            data.shippedAt = now;
            data.trackingCode = input.trackingCode;
            const shipment = await tx.shipment.create({
              data: {
                orderId,
                methodId: order.shippingMethodId,
                carrier: input.carrier,
                trackingCode: input.trackingCode,
                trackingUrl: input.trackingUrl,
                status: ShipmentStatus.IN_TRANSIT,
                shippedAt: now,
              },
            });
            await tx.trackingEvent.create({ data: { shipmentId: shipment.id, status: ShipmentStatus.IN_TRANSIT, description: input.note ?? 'Encomenda enviada', location: input.location, occurredAt: now } });
          }

          if (to === OrderStatus.OUT_FOR_DELIVERY || to === OrderStatus.DELIVERED) {
            const status = to === OrderStatus.DELIVERED ? ShipmentStatus.DELIVERED : ShipmentStatus.OUT_FOR_DELIVERY;
            const shipment = await tx.shipment.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' } });
            if (shipment) {
              await tx.shipment.update({ where: { id: shipment.id }, data: { status, ...(status === ShipmentStatus.DELIVERED ? { deliveredAt: now } : {}) } });
              await tx.trackingEvent.create({
                data: { shipmentId: shipment.id, status, description: input.note ?? (status === ShipmentStatus.DELIVERED ? 'Entregue' : 'Saiu para entrega'), location: input.location, occurredAt: now },
              });
            }
          }

          if (to === OrderStatus.DELIVERED) {
            data.deliveredAt = now;
            // Pagamento na entrega: entregue = cobrado.
            const cod = order.payments.find((p) => p.provider === 'cod' && p.status !== PaymentStatus.PAID && p.status !== PaymentStatus.CANCELLED);
            if (cod) {
              await tx.payment.update({ where: { id: cod.id }, data: { status: PaymentStatus.PAID, paidAt: now } });
              await tx.paymentTransaction.create({
                data: { paymentId: cod.id, type: PaymentTransactionType.MANUAL_CONFIRMATION, status: PaymentStatus.PAID, amount: cod.amount, createdById: ctx.actorId, rawResponse: { note: 'Collected on delivery' } },
              });
              data.paymentStatus = PaymentStatus.PAID;
            }
          }

          await tx.order.update({ where: { id: orderId }, data });
          await addHistory(tx, orderId, from, to, input.note, ctx.actorId);
        }

        await recordAudit(tx, ctx, {
          action: 'order.status',
          resourceType: 'Order',
          resourceId: orderId,
          before: { status: from },
          after: { status: to, note: input.note, trackingCode: input.trackingCode },
        });
        return { userId: order.userId, orderNumber: order.orderNumber, to, productIds: order.items.map((i) => i.productId).filter((x): x is string => Boolean(x)) };
      },
      { timeout: 15_000 },
    );

    if (result.to === OrderStatus.CANCELLED || result.to === OrderStatus.CONFIRMED) await refreshManyProductAggregates(result.productIds);
    const messages: Partial<Record<OrderStatus, [NotificationType, string]>> = {
      SHIPPED: [NotificationType.ORDER_SHIPPED, 'foi enviado'],
      OUT_FOR_DELIVERY: [NotificationType.ORDER_SHIPPED, 'saiu para entrega'],
      DELIVERED: [NotificationType.ORDER_DELIVERED, 'foi entregue'],
      CANCELLED: [NotificationType.ORDER_CANCELLED, 'foi cancelado'],
    };
    const msg = messages[result.to];
    if (msg) {
      await notify({ userId: result.userId, type: msg[0], title: `Pedido ${result.orderNumber}`, body: `O seu pedido ${msg[1]}.`, data: { orderId }, email: true });
    }
    return this.adminGet(orderId);
  }

  // ======================================================================= job
  /** Cancela pedidos não pagos cuja reserva expirou e liberta o stock. Seguro em várias instâncias. */
  async expireStaleOrders(batch = 50): Promise<number> {
    const stale = await prisma.stockReservation.findMany({
      where: { status: ReservationStatus.ACTIVE, expiresAt: { lt: new Date() } },
      select: { orderId: true },
      distinct: ['orderId'],
      take: batch,
    });
    let expired = 0;
    for (const { orderId } of stale) {
      try {
        const res = await prisma.$transaction(async (tx) => {
          const order = await lockOrder(tx, orderId);
          // Re-verificar depois do lock: o webhook pode ter confirmado o pagamento entretanto.
          if (!order || order.status !== OrderStatus.PENDING || order.paymentStatus === PaymentStatus.PAID) return null;
          await cancelOrderTx(tx, order, { reason: 'Payment not received in time', reservationStatus: ReservationStatus.EXPIRED });
          return { userId: order.userId, orderNumber: order.orderNumber, productIds: order.items.map((i) => i.productId).filter((x): x is string => Boolean(x)) };
        });
        if (res) {
          expired++;
          await refreshManyProductAggregates(res.productIds);
          await notify({ userId: res.userId, type: NotificationType.ORDER_CANCELLED, title: `Pedido ${res.orderNumber} expirou`, body: 'O pagamento não foi recebido a tempo e o pedido foi cancelado.', data: { orderId } });
        }
      } catch (err) {
        console.error('order expiration failed', { orderId, err: (err as Error).message });
      }
    }
    return expired;
  }
}
