import { prisma, RecordStatus, type Db } from '../../db/client';
import { Errors } from '../../utils/errors';
import type { CouponRule } from './pricing';

/** Validações que dependem da BD (estado, datas, limites). As regras de valor estão em pricing.ts. */
export async function loadCoupon(code: string, userId: string | null, db: Db = prisma, now = new Date()): Promise<CouponRule> {
  const coupon = await db.coupon.findFirst({ where: { code: code.trim().toUpperCase(), deletedAt: null } });
  if (!coupon || coupon.status !== RecordStatus.ACTIVE) throw Errors.unprocessable('COUPON_INVALID', 'Coupon is not valid');
  if (coupon.startsAt && coupon.startsAt > now) throw Errors.unprocessable('COUPON_NOT_STARTED', 'Coupon is not active yet');
  if (coupon.expiresAt && coupon.expiresAt <= now) throw Errors.unprocessable('COUPON_EXPIRED', 'Coupon has expired');
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    throw Errors.unprocessable('COUPON_USAGE_LIMIT_REACHED', 'Coupon usage limit reached');
  }
  if (userId && coupon.usageLimitPerUser != null) {
    const used = await db.couponUsage.count({ where: { couponId: coupon.id, userId } });
    if (used >= coupon.usageLimitPerUser) throw Errors.unprocessable('COUPON_USER_LIMIT_REACHED', 'You have already used this coupon');
  }
  return {
    id: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    value: coupon.value,
    maxDiscountAmount: coupon.maxDiscountAmount,
    minOrderAmount: coupon.minOrderAmount,
    applicableProductIds: coupon.applicableProductIds,
    applicableCategoryIds: coupon.applicableCategoryIds,
  };
}

/**
 * Regista a utilização dentro da transação do pedido.
 * - advisory lock por (cupão, cliente) serializa pedidos simultâneos do mesmo cliente;
 * - incremento condicional garante o limite global sem corridas.
 */
export async function redeemCoupon(tx: Db, coupon: CouponRule, userId: string, orderId: string, discount: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coupon:${coupon.id}:${userId}`}, 0))`;
  const fresh = await tx.coupon.findUniqueOrThrow({ where: { id: coupon.id }, select: { usageLimitPerUser: true } });
  if (fresh.usageLimitPerUser != null) {
    const used = await tx.couponUsage.count({ where: { couponId: coupon.id, userId } });
    if (used >= fresh.usageLimitPerUser) throw Errors.unprocessable('COUPON_USER_LIMIT_REACHED', 'You have already used this coupon');
  }
  const n = await tx.$executeRaw`
    UPDATE "coupons" SET "usedCount" = "usedCount" + 1, "updatedAt" = now()
    WHERE "id" = ${coupon.id}::uuid AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
  if (n === 0) throw Errors.unprocessable('COUPON_USAGE_LIMIT_REACHED', 'Coupon usage limit reached');
  await tx.couponUsage.create({ data: { couponId: coupon.id, userId, orderId, discountAmount: discount } });
}

/** Devolve a utilização quando o pedido é cancelado antes de ser pago/enviado. */
export async function revertCoupon(tx: Db, orderId: string): Promise<void> {
  const usage = await tx.couponUsage.findUnique({ where: { orderId } });
  if (!usage) return;
  await tx.couponUsage.delete({ where: { id: usage.id } });
  await tx.$executeRaw`UPDATE "coupons" SET "usedCount" = GREATEST("usedCount" - 1, 0), "updatedAt" = now() WHERE "id" = ${usage.couponId}::uuid`;
}
