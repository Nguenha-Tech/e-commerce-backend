import { z } from 'zod';
import { DiscountType, prisma, type Prisma, RecordStatus } from '../../db/client';
import { diffFields, recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { pageMeta, paginationQuery, toSkipTake } from '../../utils/pagination';

// ------------------------------------------------------------------ schemas
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Use 3-40 letters, digits, - or _');
const uuids = z.array(z.string().uuid()).max(500);
const money = z.number().int().min(0);

const fields = {
  code,
  description: z.string().trim().max(500).nullable(),
  discountType: z.nativeEnum(DiscountType),
  /** PERCENTAGE: 1..100 ; FIXED_AMOUNT: centavos ; FREE_SHIPPING: 0 */
  value: z.number().int().min(0),
  maxDiscountAmount: money.nullable(),
  minOrderAmount: money.nullable(),
  startsAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  usageLimit: z.number().int().positive().nullable(),
  usageLimitPerUser: z.number().int().positive().nullable(),
  status: z.nativeEnum(RecordStatus),
  applicableCategoryIds: uuids,
  applicableProductIds: uuids,
};

type CouponShape = Partial<{ discountType: DiscountType; value: number; startsAt: Date | null; expiresAt: Date | null }>;

function validateCoupon(c: CouponShape, ctx: z.RefinementCtx) {
  if (c.discountType === DiscountType.PERCENTAGE && (c.value! < 1 || c.value! > 100)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Percentage must be 1-100' });
  if (c.discountType === DiscountType.FIXED_AMOUNT && !(c.value! > 0)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Fixed amount must be > 0' });
  if (c.startsAt && c.expiresAt && c.startsAt >= c.expiresAt) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be after startsAt' });
}

export const createCouponBody = z
  .object({
    ...fields,
    description: fields.description.optional(),
    value: fields.value.default(0),
    maxDiscountAmount: fields.maxDiscountAmount.optional(),
    minOrderAmount: fields.minOrderAmount.optional(),
    startsAt: fields.startsAt.optional(),
    expiresAt: fields.expiresAt.optional(),
    usageLimit: fields.usageLimit.optional(),
    usageLimitPerUser: fields.usageLimitPerUser.optional(),
    status: fields.status.default(RecordStatus.ACTIVE),
    applicableCategoryIds: uuids.default([]),
    applicableProductIds: uuids.default([]),
  })
  .superRefine(validateCoupon);

export const updateCouponBody = z.object(fields).partial().strict();

export const adminCouponsQuery = paginationQuery.extend({
  search: z.string().trim().max(40).optional(),
  status: z.nativeEnum(RecordStatus).optional(),
  state: z.enum(['valid', 'scheduled', 'expired', 'exhausted']).optional(),
});

type CreateCoupon = z.infer<typeof createCouponBody>;
type UpdateCoupon = z.infer<typeof updateCouponBody>;

export class CouponsAdminService {
  async list(q: z.infer<typeof adminCouponsQuery>) {
    const now = new Date();
    const state: Record<string, Prisma.CouponWhereInput> = {
      valid: { status: RecordStatus.ACTIVE, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] },
      scheduled: { startsAt: { gt: now } },
      expired: { expiresAt: { lte: now } },
      exhausted: { usageLimit: { not: null }, usedCount: { gte: prisma.coupon.fields.usageLimit } },
    };
    const where: Prisma.CouponWhereInput = {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.search ? { code: { contains: q.search.toUpperCase() } } : {}),
      ...(q.state ? state[q.state] : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.coupon.count({ where }),
      prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async get(id: string) {
    const coupon = await prisma.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!coupon) throw Errors.notFound('Coupon');
    const stats = await prisma.couponUsage.aggregate({ where: { couponId: id }, _sum: { discountAmount: true }, _count: { _all: true } });
    return { ...coupon, stats: { uses: stats._count._all, totalDiscount: stats._sum.discountAmount ?? 0 } };
  }

  async usages(id: string, q: { page: number; limit: number }) {
    const where = { couponId: id };
    const [total, items] = await prisma.$transaction([
      prisma.couponUsage.count({ where }),
      prisma.couponUsage.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } }, order: { select: { id: true, orderNumber: true, grandTotal: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  private async assertRefs(input: { applicableCategoryIds?: string[]; applicableProductIds?: string[] }) {
    if (input.applicableProductIds?.length) {
      const n = await prisma.product.count({ where: { id: { in: input.applicableProductIds }, deletedAt: null } });
      if (n !== new Set(input.applicableProductIds).size) throw Errors.unprocessable('INVALID_REFERENCES', 'Some products do not exist');
    }
    if (input.applicableCategoryIds?.length) {
      const n = await prisma.category.count({ where: { id: { in: input.applicableCategoryIds }, deletedAt: null } });
      if (n !== new Set(input.applicableCategoryIds).size) throw Errors.unprocessable('INVALID_REFERENCES', 'Some categories do not exist');
    }
  }

  async create(ctx: AuditContext, input: CreateCoupon) {
    await this.assertRefs(input);
    if (await prisma.coupon.count({ where: { code: input.code } })) throw Errors.conflict('COUPON_CODE_EXISTS', 'Coupon code already exists');
    return prisma.$transaction(async (tx) => {
      const c = await tx.coupon.create({ data: input });
      await recordAudit(tx, ctx, { action: 'coupon.create', resourceType: 'Coupon', resourceId: c.id, after: c });
      return c;
    });
  }

  async update(ctx: AuditContext, id: string, input: UpdateCoupon) {
    const current = await prisma.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Errors.notFound('Coupon');
    if (current.usedCount > 0 && (input.code || input.discountType)) {
      // Preserva o histórico: pedidos já feitos referem-se ao código/tipo originais.
      throw Errors.unprocessable('COUPON_IN_USE', 'Code and discount type cannot change after the coupon has been used; create a new coupon');
    }
    const check = z.object({}).passthrough().superRefine((v, c) => validateCoupon(v as CouponShape, c)).safeParse({ ...current, ...input });
    if (!check.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid coupon', check.error.flatten());
    await this.assertRefs(input);
    if (input.code && input.code !== current.code && (await prisma.coupon.count({ where: { code: input.code } }))) throw Errors.conflict('COUPON_CODE_EXISTS', 'Coupon code already exists');

    return prisma.$transaction(async (tx) => {
      const c = await tx.coupon.update({ where: { id }, data: input });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'coupon.update', resourceType: 'Coupon', resourceId: id, ...diff });
      return c;
    });
  }

  async remove(ctx: AuditContext, id: string) {
    const current = await prisma.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Errors.notFound('Coupon');
    await prisma.$transaction(async (tx) => {
      await tx.coupon.update({ where: { id }, data: { deletedAt: new Date(), status: RecordStatus.INACTIVE } });
      await recordAudit(tx, ctx, { action: 'coupon.delete', resourceType: 'Coupon', resourceId: id, before: { code: current.code, status: current.status } });
    });
  }
}
