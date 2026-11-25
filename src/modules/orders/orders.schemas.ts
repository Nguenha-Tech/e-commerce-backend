import { z } from 'zod';
import { OrderStatus, PaymentStatus } from '../../db/client';
import { paginationQuery } from '../../utils/pagination';

export const idParams = z.object({ id: z.string().uuid() });
export const itemIdParams = z.object({ itemId: z.string().uuid() });
export const orderPaymentParams = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() });

const quantity = z.number().int().min(1).max(1000);

export const addCartItemBody = z.object({ variantId: z.string().uuid(), quantity: quantity.default(1) });
export const updateCartItemBody = z.object({ quantity });
export const applyCouponBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Invalid coupon code') });
export const cartQuery = z.object({ shippingMethod: z.string().max(40).optional(), addressId: z.string().uuid().optional() });

/** Chave enviada pelo cliente para tornar o pedido idempotente (ex.: UUID gerado ao abrir o checkout). */
export const idempotencyHeaders = z.object({
  'idempotency-key': z.string().trim().min(8, 'Idempotency-Key header is required (min 8 chars)').max(100),
});

export const checkoutBody = z.object({
  addressId: z.string().uuid().optional(),
  shippingMethodCode: z.string().trim().min(2).max(40),
  paymentMethodCode: z.string().trim().min(2).max(40),
  couponCode: z.string().trim().toUpperCase().max(40).optional(),
  customerNote: z.string().trim().max(500).optional(),
  items: z
    .array(z.object({ variantId: z.string().uuid(), quantity }))
    .min(1)
    .max(50)
    .refine((a) => new Set(a.map((i) => i.variantId)).size === a.length, 'Duplicate variants')
    .optional(),
  expectedTotal: z.number().int().min(0).optional(),
});

export const shippingQuery = z.object({ addressId: z.string().uuid().optional() });

export const listOrdersQuery = paginationQuery.extend({ status: z.nativeEnum(OrderStatus).optional() });

export const cancelOrderBody = z.object({ reason: z.string().trim().min(3).max(300) });

export const retryPaymentBody = z.object({ paymentMethodCode: z.string().trim().max(40).optional() }).optional();

export const adminListOrdersQuery = paginationQuery.extend({
  status: z.nativeEnum(OrderStatus).optional(),
  paymentStatus: z.nativeEnum(PaymentStatus).optional(),
  search: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  requiresAttention: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const updateOrderStatusBody = z.object({
  status: z.nativeEnum(OrderStatus),
  note: z.string().trim().max(500).optional(),
  trackingCode: z.string().trim().max(80).optional(),
  carrier: z.string().trim().max(80).optional(),
  trackingUrl: z.string().url().max(500).optional(),
  location: z.string().trim().max(120).optional(),
});

export const confirmPaymentBody = z.object({ note: z.string().trim().min(3).max(300) });

export const webhookParams = z.object({ provider: z.string().regex(/^[a-z0-9_-]{2,40}$/) });
