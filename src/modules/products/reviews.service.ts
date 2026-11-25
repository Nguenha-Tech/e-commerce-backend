import { NotificationType, OrderStatus, prisma, Prisma, ReviewStatus, type Db } from '../../db/client';
import { recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { notify } from '../../utils/notifications';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import type { StorageProvider } from '../uploads/storage/storage.provider';
import type { AdminReviewsQuery, CreateReviewInput, ListReviewsQuery, UpdateReviewInput } from './reviews.schemas';
import { getSetting } from './storefront/settings.service';

/** Só quem recebeu o produto pode avaliar (compra verificada). */
const REVIEWABLE_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.RETURN_REQUESTED];
/** A partir de N denúncias, uma avaliação publicada volta para moderação. */
const AUTO_HIDE_REPORTS = 3;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Primeiro nome + inicial do apelido (privacidade). */
export function displayName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : parts[0] ?? 'Cliente';
}

/** Recalcula ratingAvg/ratingCount do produto a partir das avaliações APROVADAS. */
export async function refreshProductRating(productId: string, db: Db = prisma): Promise<void> {
  const agg = await db.review.aggregate({ where: { productId, status: ReviewStatus.APPROVED }, _avg: { rating: true }, _count: { _all: true } });
  await db.product.update({ where: { id: productId }, data: { ratingAvg: agg._avg.rating ?? 0, ratingCount: agg._count._all } });
}

const publicSelect = {
  id: true, rating: true, title: true, comment: true, createdAt: true, adminReply: true, adminReplyAt: true,
  user: { select: { name: true } },
  images: { select: { url: true }, orderBy: { sortOrder: 'asc' } },
  orderItem: { select: { variantName: true } },
} satisfies Prisma.ReviewSelect;

export class ReviewsService {
  constructor(private readonly storage: StorageProvider) {}

  // ------------------------------------------------------------------ público
  async listForProduct(productId: string, q: ListReviewsQuery) {
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, ratingAvg: true, ratingCount: true } });
    if (!product) throw Errors.notFound('Product');

    const where: Prisma.ReviewWhereInput = {
      productId,
      status: ReviewStatus.APPROVED,
      ...(q.rating ? { rating: q.rating } : {}),
      ...(q.withPhotos ? { images: { some: {} } } : {}),
    };
    const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
      q.sort === 'rating_desc' ? [{ rating: 'desc' }, { createdAt: 'desc' }] : q.sort === 'rating_asc' ? [{ rating: 'asc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }];

    const [total, rows, distribution] = await prisma.$transaction([
      prisma.review.count({ where }),
      prisma.review.findMany({ where, select: publicSelect, orderBy, ...toSkipTake(q) }),
      prisma.review.groupBy({ by: ['rating'], where: { productId, status: ReviewStatus.APPROVED }, _count: { _all: true }, orderBy: { rating: 'desc' } }),
    ]);

    const dist: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const d of distribution) dist[d.rating] = (d._count as { _all: number })._all;

    return {
      items: rows.map(({ user, orderItem, ...r }) => ({ ...r, author: displayName(user.name), variant: orderItem.variantName, verifiedPurchase: true })),
      meta: { ...pageMeta(total, q), summary: { average: Math.round(product.ratingAvg * 10) / 10, count: product.ratingCount, distribution: dist } },
    };
  }

  // ------------------------------------------------------------------ cliente
  /** Produtos entregues ainda por avaliar. */
  async eligible(userId: string) {
    const items = await prisma.orderItem.findMany({
      where: { order: { userId, status: { in: REVIEWABLE_ORDER_STATUSES } }, productId: { not: null }, review: null, product: { reviews: { none: { userId } } } },
      select: { id: true, productId: true, productName: true, productSlug: true, variantName: true, imageUrl: true, order: { select: { orderNumber: true, deliveredAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // Um produto comprado várias vezes aparece uma só vez.
    const seen = new Set<string>();
    return items.filter((i) => (seen.has(i.productId!) ? false : (seen.add(i.productId!), true)));
  }

  async listMine(userId: string, q: { page: number; limit: number }) {
    const where = { userId };
    const [total, items] = await prisma.$transaction([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        include: { images: { select: { id: true, url: true } }, product: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async create(userId: string, productId: string, input: CreateReviewInput) {
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true } });
    if (!product) throw Errors.notFound('Product');

    const orderItem = await prisma.orderItem.findFirst({
      where: { productId, review: null, order: { userId, status: { in: REVIEWABLE_ORDER_STATUSES } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!orderItem) {
      const already = await prisma.review.count({ where: { productId, userId } });
      if (already) throw Errors.conflict('REVIEW_ALREADY_EXISTS', 'You have already reviewed this product');
      throw Errors.forbidden('Only customers who received this product can review it', 'REVIEW_NOT_ALLOWED');
    }

    const cfg = await getSetting('reviews');
    if (input.images.length && !cfg.allowPhotos) throw Errors.unprocessable('REVIEW_PHOTOS_DISABLED', 'Photos are not allowed in reviews');
    if (input.images.length > cfg.maxPhotos) throw Errors.unprocessable('TOO_MANY_PHOTOS', `Maximum ${cfg.maxPhotos} photos`);

    const status = cfg.requireApproval ? ReviewStatus.PENDING : ReviewStatus.APPROVED;
    try {
      const review = await prisma.$transaction(async (tx) => {
        const r = await tx.review.create({
          data: {
            productId,
            userId,
            orderItemId: orderItem.id,
            rating: input.rating,
            title: input.title,
            comment: input.comment,
            status,
            // URL derivado da chave pelo próprio servidor — nunca aceitar URLs do cliente.
            images: { create: input.images.map((img, i) => ({ storageKey: img.storageKey, url: this.storage.publicUrl(img.storageKey), sortOrder: i })) },
          },
          include: { images: { select: { id: true, url: true } } },
        });
        if (status === ReviewStatus.APPROVED) await refreshProductRating(productId, tx);
        return r;
      });
      return review;
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('REVIEW_ALREADY_EXISTS', 'You have already reviewed this product');
      throw err;
    }
  }

  async updateMine(userId: string, id: string, input: UpdateReviewInput) {
    const review = await prisma.review.findFirst({ where: { id, userId } });
    if (!review) throw Errors.notFound('Review');
    if (review.status === ReviewStatus.REJECTED) throw Errors.unprocessable('REVIEW_LOCKED', 'This review was rejected and cannot be edited');
    const cfg = await getSetting('reviews');
    // Conteúdo alterado volta à moderação quando a loja exige aprovação.
    const status = cfg.requireApproval ? ReviewStatus.PENDING : review.status;
    return prisma.$transaction(async (tx) => {
      const r = await tx.review.update({ where: { id }, data: { ...input, status } });
      await refreshProductRating(review.productId, tx);
      return r;
    });
  }

  async deleteMine(userId: string, id: string) {
    const review = await prisma.review.findFirst({ where: { id, userId }, include: { images: true } });
    if (!review) throw Errors.notFound('Review');
    await prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id } });
      await refreshProductRating(review.productId, tx);
    });
    await Promise.all(review.images.map((i) => this.storage.delete(i.storageKey).catch(() => undefined)));
  }

  async report(userId: string, id: string, reason: string) {
    const review = await prisma.review.findFirst({ where: { id, status: ReviewStatus.APPROVED }, select: { id: true, userId: true, productId: true } });
    if (!review) throw Errors.notFound('Review');
    if (review.userId === userId) throw Errors.badRequest('CANNOT_REPORT_OWN_REVIEW', 'You cannot report your own review');
    try {
      await prisma.$transaction(async (tx) => {
        await tx.reviewReport.create({ data: { reviewId: id, userId, reason } });
        const updated = await tx.review.update({ where: { id }, data: { reportCount: { increment: 1 } } });
        if (updated.reportCount >= AUTO_HIDE_REPORTS && updated.status === ReviewStatus.APPROVED) {
          await tx.review.update({ where: { id }, data: { status: ReviewStatus.PENDING } });
          await refreshProductRating(review.productId, tx);
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) return; // denúncia repetida é ignorada (idempotente)
      throw err;
    }
  }

  // ------------------------------------------------------------------ admin
  async adminList(q: AdminReviewsQuery) {
    const where: Prisma.ReviewWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.rating ? { rating: q.rating } : {}),
      ...(q.reported ? { reportCount: { gt: 0 } } : {}),
      ...(q.unanswered ? { adminReply: null } : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          product: { select: { id: true, name: true, slug: true } },
          images: { select: { url: true } },
          reports: { select: { reason: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5 },
        },
        orderBy: [{ reportCount: 'desc' }, { createdAt: 'desc' }],
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async moderate(ctx: AuditContext, id: string, status: ReviewStatus, note?: string) {
    const review = await prisma.review.findUnique({ where: { id } });
    if (!review) throw Errors.notFound('Review');
    return prisma.$transaction(async (tx) => {
      const r = await tx.review.update({ where: { id }, data: { status, ...(status === ReviewStatus.APPROVED ? { reportCount: 0 } : {}) } });
      if (status === ReviewStatus.APPROVED) await tx.reviewReport.deleteMany({ where: { reviewId: id } });
      await refreshProductRating(review.productId, tx);
      await recordAudit(tx, ctx, { action: 'review.moderate', resourceType: 'Review', resourceId: id, before: { status: review.status }, after: { status, note } });
      return r;
    });
  }

  async reply(ctx: AuditContext, id: string, reply: string) {
    const review = await prisma.review.findUnique({ where: { id }, include: { product: { select: { name: true, slug: true } } } });
    if (!review) throw Errors.notFound('Review');
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.review.update({ where: { id }, data: { adminReply: reply, adminReplyAt: new Date(), repliedById: ctx.actorId } });
      await recordAudit(tx, ctx, { action: 'review.reply', resourceType: 'Review', resourceId: id, before: { adminReply: review.adminReply }, after: { adminReply: reply } });
      return r;
    });
    await notify({
      userId: review.userId,
      type: NotificationType.ACCOUNT,
      title: 'A loja respondeu à sua avaliação',
      body: `Resposta à sua avaliação de ${review.product.name}.`,
      data: { reviewId: id, slug: review.product.slug },
    });
    return updated;
  }

  async remove(ctx: AuditContext, id: string) {
    const review = await prisma.review.findUnique({ where: { id }, include: { images: true } });
    if (!review) throw Errors.notFound('Review');
    await prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id } });
      await refreshProductRating(review.productId, tx);
      await recordAudit(tx, ctx, { action: 'review.delete', resourceType: 'Review', resourceId: id, before: { rating: review.rating, comment: review.comment, userId: review.userId } });
    });
    await Promise.all(review.images.map((i) => this.storage.delete(i.storageKey).catch(() => undefined)));
  }

  /** Valida, antes do upload, se a loja aceita fotos nas avaliações. */
  async assertCanUploadPhotos() {
    const cfg = await getSetting('reviews');
    if (!cfg.allowPhotos) throw Errors.unprocessable('REVIEW_PHOTOS_DISABLED', 'Photos are not allowed in reviews');
  }
}

