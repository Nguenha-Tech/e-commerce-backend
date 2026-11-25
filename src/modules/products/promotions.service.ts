import { z } from 'zod';
import { DiscountType, prisma, type Prisma, PromotionKind, PromotionScope } from '../../db/client';
import { diffFields, recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { pageMeta, paginationQuery, toSkipTake } from '../../utils/pagination';
import { uniqueSlug } from '../../utils/slug';
import { refreshManyProductAggregates } from './aggregates';
import { invalidatePromotionCache } from './price-resolver';
import { cardSelect, PUBLIC_STATUSES, toCard } from './products.service';

/*
 * Promoções automáticas (sem código): desconto % ou fixo por produto, categoria, marca ou loja.
 * Tipos: REGULAR, FLASH_SALE, SEASONAL (Black Friday…). O preço final é sempre calculado
 * por price-resolver.ts (mesma fonte para catálogo, carrinho e checkout).
 */

const uuids = z.array(z.string().uuid()).max(500);
const base = {
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(140),
  description: z.string().trim().max(2000).nullable(),
  kind: z.nativeEnum(PromotionKind),
  scope: z.nativeEnum(PromotionScope),
  discountType: z.enum([DiscountType.PERCENTAGE, DiscountType.FIXED_AMOUNT]),
  /** PERCENTAGE: 1..95 ; FIXED_AMOUNT: centavos. */
  value: z.number().int().positive(),
  productIds: uuids,
  categoryIds: uuids,
  brandIds: uuids,
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  priority: z.number().int().min(0).max(1000),
  isActive: z.boolean(),
  imageUrl: z.string().url().max(500).nullable(),
};

type PromoShape = { scope?: PromotionScope; discountType?: DiscountType; value?: number; productIds?: string[]; categoryIds?: string[]; brandIds?: string[]; startsAt?: Date; endsAt?: Date };

function validateRules(p: PromoShape, ctx: z.RefinementCtx) {
  if (p.startsAt && p.endsAt && p.startsAt >= p.endsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
  if (p.discountType === DiscountType.PERCENTAGE && p.value !== undefined && p.value > 95) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Percentage must be between 1 and 95' });
  const need: Partial<Record<PromotionScope, keyof PromoShape>> = { PRODUCT: 'productIds', CATEGORY: 'categoryIds', BRAND: 'brandIds' };
  const field = p.scope ? need[p.scope] : undefined;
  if (field && !(p[field] as string[] | undefined)?.length) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for scope ${p.scope}` });
}

export const createPromotionBody = z
  .object({
    ...base,
    slug: base.slug.optional(),
    description: base.description.optional(),
    kind: base.kind.default(PromotionKind.REGULAR),
    productIds: uuids.default([]),
    categoryIds: uuids.default([]),
    brandIds: uuids.default([]),
    priority: base.priority.default(0),
    isActive: base.isActive.default(true),
    imageUrl: base.imageUrl.optional(),
  })
  .superRefine(validateRules);

export const updatePromotionBody = z.object(base).partial().strict();

export const listPromotionsQuery = z.object({ kind: z.nativeEnum(PromotionKind).optional() });
export const promotionProductsQuery = paginationQuery;
export const adminPromotionsQuery = paginationQuery.extend({
  kind: z.nativeEnum(PromotionKind).optional(),
  state: z.enum(['active', 'scheduled', 'ended', 'disabled']).optional(),
  search: z.string().trim().max(100).optional(),
});

type CreatePromotion = z.infer<typeof createPromotionBody>;
type UpdatePromotion = z.infer<typeof updatePromotionBody>;
type PromotionRow = Prisma.PromotionGetPayload<object>;

/** Filtro de produtos abrangidos por uma promoção. */
function scopeWhere(p: Pick<PromotionRow, 'scope' | 'productIds' | 'categoryIds' | 'brandIds'>): Prisma.ProductWhereInput {
  switch (p.scope) {
    case PromotionScope.PRODUCT:
      return { id: { in: p.productIds } };
    case PromotionScope.CATEGORY:
      return { categoryId: { in: p.categoryIds } };
    case PromotionScope.BRAND:
      return { brandId: { in: p.brandIds } };
    default:
      return {};
  }
}

async function affectedProductIds(...promos: Array<Pick<PromotionRow, 'scope' | 'productIds' | 'categoryIds' | 'brandIds'> | null | undefined>) {
  const ids = new Set<string>();
  for (const p of promos) {
    if (!p) continue;
    const rows = await prisma.product.findMany({ where: { deletedAt: null, ...scopeWhere(p) }, select: { id: true } });
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

/** Recalcula preços desnormalizados fora do pedido HTTP (pode envolver muitos produtos). */
function refreshInBackground(ids: Set<string>) {
  invalidatePromotionCache();
  if (ids.size === 0) return;
  setImmediate(() => void refreshManyProductAggregates(ids));
}

const publicSelect = {
  id: true, name: true, slug: true, description: true, kind: true, scope: true, discountType: true, value: true, startsAt: true, endsAt: true, imageUrl: true,
} satisfies Prisma.PromotionSelect;

export class PromotionsService {
  private activeWhere(now = new Date()): Prisma.PromotionWhereInput {
    return { isActive: true, deletedAt: null, startsAt: { lte: now }, endsAt: { gt: now } };
  }

  async listActive(kind?: PromotionKind) {
    return prisma.promotion.findMany({
      where: { ...this.activeWhere(), ...(kind ? { kind } : {}) },
      select: publicSelect,
      orderBy: [{ priority: 'desc' }, { endsAt: 'asc' }],
      take: 50,
    });
  }

  async getBySlug(slug: string, q: { page: number; limit: number }) {
    const promo = await prisma.promotion.findFirst({ where: { slug, ...this.activeWhere() } });
    if (!promo) throw Errors.notFound('Promotion');
    const where: Prisma.ProductWhereInput = { deletedAt: null, status: { in: PUBLIC_STATUSES }, ...scopeWhere(promo) };
    const [total, rows] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, select: cardSelect, orderBy: [{ maxDiscountPercent: 'desc' }, { soldCount: 'desc' }], ...toSkipTake(q) }),
    ]);
    const { productIds: _p, categoryIds: _c, brandIds: _b, priority: _pr, isActive: _a, deletedAt: _d, ...pub } = promo;
    return { promotion: pub, items: rows.map(toCard), meta: pageMeta(total, q) };
  }

  // ------------------------------------------------------------------ admin
  async adminList(q: z.infer<typeof adminPromotionsQuery>) {
    const now = new Date();
    const stateWhere: Record<string, Prisma.PromotionWhereInput> = {
      active: this.activeWhere(now),
      scheduled: { isActive: true, startsAt: { gt: now } },
      ended: { endsAt: { lte: now } },
      disabled: { isActive: false },
    };
    const where: Prisma.PromotionWhereInput = {
      deletedAt: null,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.state ? stateWhere[q.state] : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.promotion.count({ where }),
      prisma.promotion.findMany({ where, orderBy: [{ startsAt: 'desc' }], ...toSkipTake(q) }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async adminGet(id: string) {
    const promo = await prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!promo) throw Errors.notFound('Promotion');
    const affected = await prisma.product.count({ where: { deletedAt: null, ...scopeWhere(promo) } });
    return { ...promo, affectedProducts: affected };
  }

  private async assertRefs(p: PromoShape) {
    const check = async (ids: string[] | undefined, count: (ids: string[]) => Promise<number>, name: string) => {
      if (ids?.length && (await count(ids)) !== new Set(ids).size) throw Errors.unprocessable('INVALID_REFERENCES', `Some ${name} do not exist`);
    };
    await check(p.productIds, (ids) => prisma.product.count({ where: { id: { in: ids }, deletedAt: null } }), 'products');
    await check(p.categoryIds, (ids) => prisma.category.count({ where: { id: { in: ids }, deletedAt: null } }), 'categories');
    await check(p.brandIds, (ids) => prisma.brand.count({ where: { id: { in: ids }, deletedAt: null } }), 'brands');
  }

  async create(ctx: AuditContext, input: CreatePromotion) {
    await this.assertRefs(input);
    const slug = input.slug
      ? input.slug
      : await uniqueSlug(input.name, async (s) => (await prisma.promotion.count({ where: { slug: s } })) > 0);
    if (input.slug && (await prisma.promotion.count({ where: { slug } }))) throw Errors.conflict('SLUG_ALREADY_EXISTS', 'Slug already in use');

    const promo = await prisma.$transaction(async (tx) => {
      const p = await tx.promotion.create({ data: { ...input, slug } });
      await recordAudit(tx, ctx, { action: 'promotion.create', resourceType: 'Promotion', resourceId: p.id, after: p });
      return p;
    });
    refreshInBackground(await affectedProductIds(promo));
    return promo;
  }

  async update(ctx: AuditContext, id: string, input: UpdatePromotion) {
    const current = await prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Errors.notFound('Promotion');
    const merged = { ...current, ...input };
    const check = z.object({}).passthrough().superRefine((v, c) => validateRules(v as PromoShape, c)).safeParse(merged);
    if (!check.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid promotion', check.error.flatten());
    await this.assertRefs(input);
    if (input.slug && input.slug !== current.slug && (await prisma.promotion.count({ where: { slug: input.slug } }))) {
      throw Errors.conflict('SLUG_ALREADY_EXISTS', 'Slug already in use');
    }

    const promo = await prisma.$transaction(async (tx) => {
      const p = await tx.promotion.update({ where: { id }, data: input });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'promotion.update', resourceType: 'Promotion', resourceId: id, ...diff });
      return p;
    });
    refreshInBackground(await affectedProductIds(current, promo));
    return promo;
  }

  async remove(ctx: AuditContext, id: string) {
    const current = await prisma.promotion.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Errors.notFound('Promotion');
    await prisma.$transaction(async (tx) => {
      await tx.promotion.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await recordAudit(tx, ctx, { action: 'promotion.delete', resourceType: 'Promotion', resourceId: id, before: { name: current.name, isActive: current.isActive } });
    });
    refreshInBackground(await affectedProductIds(current));
  }

  /**
   * Job: promoções que começaram ou terminaram desde a última execução alteram preços
   * mostrados no catálogo (minPrice, isOnSale…). Recalcula só os produtos afetados.
   */
  async syncWindows(since: Date, now = new Date()): Promise<number> {
    const changed = await prisma.promotion.findMany({
      where: { deletedAt: null, OR: [{ startsAt: { gt: since, lte: now } }, { endsAt: { gt: since, lte: now } }] },
      select: { scope: true, productIds: true, categoryIds: true, brandIds: true },
    });
    if (changed.length === 0) return 0;
    invalidatePromotionCache();
    const ids = await affectedProductIds(...changed);
    await refreshManyProductAggregates(ids);
    return ids.size;
  }
}
