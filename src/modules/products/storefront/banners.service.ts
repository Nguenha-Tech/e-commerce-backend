import { z } from 'zod';
import { BannerPlacement, prisma, type Prisma } from '../../../db/client';
import { diffFields, recordAudit, type AuditContext } from '../../../utils/audit';
import { TtlCache } from '../../../utils/cache';
import { Errors } from '../../../utils/errors';
import { pageMeta, paginationQuery, toSkipTake } from '../../../utils/pagination';

const bannerFields = {
  title: z.string().trim().min(2).max(120),
  subtitle: z.string().trim().max(200).nullable(),
  imageUrl: z.string().url().max(500),
  mobileImageUrl: z.string().url().max(500).nullable(),
  /** Link relativo (/promocoes/black-friday) ou absoluto https. */
  linkUrl: z.string().trim().max(500).regex(/^(\/|https:\/\/)/, 'Use a relative path or https URL').nullable(),
  productId: z.string().uuid().nullable(),
  categoryId: z.string().uuid().nullable(),
  placement: z.nativeEnum(BannerPlacement),
  startsAt: z.coerce.date().nullable(),
  endsAt: z.coerce.date().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

const dateOrder = (v: { startsAt?: Date | null; endsAt?: Date | null }) => !v.startsAt || !v.endsAt || v.startsAt < v.endsAt;

export const createBannerBody = z
  .object({
    ...bannerFields,
    subtitle: bannerFields.subtitle.optional(),
    mobileImageUrl: bannerFields.mobileImageUrl.optional(),
    linkUrl: bannerFields.linkUrl.optional(),
    productId: bannerFields.productId.optional(),
    categoryId: bannerFields.categoryId.optional(),
    placement: bannerFields.placement.default(BannerPlacement.HOMEPAGE),
    startsAt: bannerFields.startsAt.optional(),
    endsAt: bannerFields.endsAt.optional(),
    isActive: bannerFields.isActive.default(true),
    sortOrder: bannerFields.sortOrder.default(0),
  })
  .refine(dateOrder, { message: 'startsAt must be before endsAt', path: ['endsAt'] });

export const updateBannerBody = z.object(bannerFields).partial().strict().refine(dateOrder, { message: 'startsAt must be before endsAt', path: ['endsAt'] });

export const publicBannersQuery = z.object({
  placement: z.nativeEnum(BannerPlacement).default(BannerPlacement.HOMEPAGE),
  categoryId: z.string().uuid().optional(),
});

export const adminBannersQuery = paginationQuery.extend({
  placement: z.nativeEnum(BannerPlacement).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

type CreateBanner = z.infer<typeof createBannerBody>;
type UpdateBanner = z.infer<typeof updateBannerBody>;

const publicSelect = {
  id: true, title: true, subtitle: true, imageUrl: true, mobileImageUrl: true, linkUrl: true, placement: true, sortOrder: true,
  product: { select: { id: true, slug: true, name: true } },
  category: { select: { id: true, slug: true, name: true } },
} satisfies Prisma.BannerSelect;

const cache = new TtlCache<unknown>(30_000);

export class BannersService {
  async listPublic(q: z.infer<typeof publicBannersQuery>) {
    const key = `${q.placement}:${q.categoryId ?? ''}`;
    return cache.getOrSet(key, () => {
      const now = new Date();
      return prisma.banner.findMany({
        where: {
          placement: q.placement,
          isActive: true,
          deletedAt: null,
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
          AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
        },
        select: publicSelect,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        take: 20,
      });
    });
  }

  async adminList(q: z.infer<typeof adminBannersQuery>) {
    const where: Prisma.BannerWhereInput = {
      deletedAt: null,
      ...(q.placement ? { placement: q.placement } : {}),
      ...(q.active !== undefined ? { isActive: q.active } : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.banner.count({ where }),
      prisma.banner.findMany({ where, include: { product: { select: { name: true } }, category: { select: { name: true } } }, orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }], ...toSkipTake(q) }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  private async assertRefs(input: { productId?: string | null; categoryId?: string | null }) {
    if (input.productId && !(await prisma.product.count({ where: { id: input.productId, deletedAt: null } }))) throw Errors.notFound('Product');
    if (input.categoryId && !(await prisma.category.count({ where: { id: input.categoryId, deletedAt: null } }))) throw Errors.notFound('Category');
  }

  async create(ctx: AuditContext, input: CreateBanner) {
    await this.assertRefs(input);
    const banner = await prisma.$transaction(async (tx) => {
      const b = await tx.banner.create({ data: input });
      await recordAudit(tx, ctx, { action: 'banner.create', resourceType: 'Banner', resourceId: b.id, after: b });
      return b;
    });
    cache.clear();
    return banner;
  }

  async update(ctx: AuditContext, id: string, input: UpdateBanner) {
    const current = await prisma.banner.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Errors.notFound('Banner');
    await this.assertRefs(input);
    const merged = { startsAt: input.startsAt !== undefined ? input.startsAt : current.startsAt, endsAt: input.endsAt !== undefined ? input.endsAt : current.endsAt };
    if (!dateOrder(merged)) throw Errors.badRequest('INVALID_DATE_RANGE', 'startsAt must be before endsAt');
    const banner = await prisma.$transaction(async (tx) => {
      const b = await tx.banner.update({ where: { id }, data: input });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'banner.update', resourceType: 'Banner', resourceId: id, ...diff });
      return b;
    });
    cache.clear();
    return banner;
  }

  async remove(ctx: AuditContext, id: string) {
    const current = await prisma.banner.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw Errors.notFound('Banner');
    await prisma.$transaction(async (tx) => {
      await tx.banner.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
      await recordAudit(tx, ctx, { action: 'banner.delete', resourceType: 'Banner', resourceId: id, before: { title: current.title } });
    });
    cache.clear();
  }
}
