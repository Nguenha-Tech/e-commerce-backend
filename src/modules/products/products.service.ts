import { env } from '../../config/env';
import { OrderStatus, prisma, Prisma, ProductRelationType, ProductStatus, RecordStatus } from '../../db/client';
import { Errors } from '../../utils/errors';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import { descendantIds, findCategoryBySlugOrId } from '../categories/categories.service';
import { getActivePromotions, resolvePrice, type PromotionRule } from './price-resolver';
import type { ListProductsQuery, ProductSort } from './products.schemas';
import { frontendLinks } from '../../utils/frontend-links';

/** Estados visíveis no catálogo público. */
export const PUBLIC_STATUSES = [ProductStatus.ACTIVE, ProductStatus.OUT_OF_STOCK];
const LOW_STOCK_THRESHOLD = 5;

export const cardSelect = {
  id: true,
  name: true,
  slug: true,
  shortDescription: true,
  status: true,
  currency: true,
  minPrice: true,
  maxPrice: true,
  maxDiscountPercent: true,
  isOnSale: true,
  isFeatured: true,
  isNew: true,
  isRecommended: true,
  availableStock: true,
  soldCount: true,
  ratingAvg: true,
  ratingCount: true,
  brand: { select: { id: true, name: true, slug: true } },
  category: { select: { id: true, name: true, slug: true } },
  images: { select: { url: true, thumbnailUrl: true, altText: true }, orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }], take: 1 },
  variants: {
    where: { deletedAt: null, isActive: true },
    select: { originalPrice: true, price: true },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    take: 1,
  },
  _count: { select: { variants: { where: { deletedAt: null, isActive: true } } } },
} satisfies Prisma.ProductSelect;

type CardRow = Prisma.ProductGetPayload<{ select: typeof cardSelect }>;

export function toCard(p: CardRow) {
  const main = p.images[0];
  const ref = p.variants[0];
  const compareAt = ref ? Math.max(ref.originalPrice, ref.price) : p.maxPrice;
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    shortDescription: p.shortDescription,
    brand: p.brand,
    category: p.category,
    image: main ?? null,
    price: {
      currency: p.currency,
      from: p.minPrice,
      to: p.maxPrice,
      compareAt: compareAt > p.minPrice ? compareAt : null,
      discountPercent: p.maxDiscountPercent,
    },
    rating: { average: Math.round(p.ratingAvg * 10) / 10, count: p.ratingCount },
    soldCount: p.soldCount,
    inStock: p.availableStock > 0,
    hasVariants: p._count.variants > 1,
    flags: { featured: p.isFeatured, new: p.isNew, onSale: p.isOnSale, recommended: p.isRecommended },
  };
}

const ORDER_BY: Record<ProductSort, Prisma.ProductOrderByWithRelationInput[]> = {
  relevance: [{ soldCount: 'desc' }, { ratingAvg: 'desc' }],
  newest: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  best_selling: [{ soldCount: 'desc' }],
  price_asc: [{ minPrice: 'asc' }],
  price_desc: [{ minPrice: 'desc' }],
  rating: [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }],
  popular: [{ viewCount: 'desc' }],
  discount: [{ maxDiscountPercent: 'desc' }],
};

function parsePair(raw: string): [string, string] | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const key = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  return key && value ? [key, value] : null;
}

/** Cada termo tem de aparecer em algum campo (AND entre termos, OR entre campos). */
function searchConditions(search: string): Prisma.ProductWhereInput[] {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, 6);
  return terms.map((term) => {
    const contains = { contains: term, mode: 'insensitive' as const };
    return {
      OR: [
        { name: contains },
        { sku: contains },
        { shortDescription: contains },
        { description: contains },
        { brand: { name: contains } },
        { category: { name: contains } },
        { tags: { some: { tag: { name: contains } } } },
        { specifications: { some: { OR: [{ value: contains }, { key: contains }] } } },
        { variants: { some: { deletedAt: null, OR: [{ sku: contains }, { name: contains }] } } },
      ],
    };
  });
}

async function buildWhere(q: ListProductsQuery): Promise<Prisma.ProductWhereInput> {
  const and: Prisma.ProductWhereInput[] = [{ deletedAt: null, status: { in: PUBLIC_STATUSES } }];

  if (q.search) and.push(...searchConditions(q.search));
  if (q.category) {
    const cat = await findCategoryBySlugOrId(q.category);
    if (!cat || cat.status !== RecordStatus.ACTIVE) and.push({ id: { in: [] } });
    else and.push({ categoryId: { in: await descendantIds(cat.id) } });
  }
  if (q.brand?.length) and.push({ brand: { slug: { in: q.brand }, status: RecordStatus.ACTIVE } });
  if (q.tags?.length) and.push({ tags: { some: { tag: { slug: { in: q.tags } } } } });
  if (q.minPrice !== undefined) and.push({ minPrice: { gte: q.minPrice } });
  if (q.maxPrice !== undefined) and.push({ minPrice: { lte: q.maxPrice } });
  if (q.minRating !== undefined) and.push({ ratingAvg: { gte: q.minRating } });
  if (q.inStock) and.push({ availableStock: { gt: 0 } });
  if (q.onSale) and.push({ isOnSale: true });
  if (q.featured) and.push({ isFeatured: true });
  if (q.isNew) and.push({ isNew: true });

  const variantBase = { deletedAt: null, isActive: true };
  if (q.color?.length) {
    and.push({ variants: { some: { ...variantBase, OR: q.color.map((c) => ({ options: { path: ['color'], equals: c } })) } } });
  }
  for (const pair of (q.option ?? []).map(parsePair)) {
    if (pair) and.push({ variants: { some: { ...variantBase, options: { path: [pair[0]], equals: pair[1] } } } });
  }
  for (const pair of (q.spec ?? []).map(parsePair)) {
    if (pair) {
      and.push({
        specifications: {
          some: { isFilterable: true, key: { equals: pair[0], mode: 'insensitive' }, value: { equals: pair[1], mode: 'insensitive' } },
        },
      });
    }
  }
  return { AND: and };
}

function stockLevel(available: number) {
  if (available <= 0) return 'OUT_OF_STOCK' as const;
  if (available <= LOW_STOCK_THRESHOLD) return 'LOW_STOCK' as const;
  return 'IN_STOCK' as const;
}

export class ProductsService {
  async list(q: ListProductsQuery) {
    const where = await buildWhere(q);
    const sort: ProductSort = q.sort ?? (q.search ? 'relevance' : 'newest');
    const [total, rows] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, select: cardSelect, orderBy: [...ORDER_BY[sort], { id: 'asc' }], ...toSkipTake(q) }),
    ]);
    return { items: rows.map(toCard), meta: { ...pageMeta(total, q), sort } };
  }

  /** Facetas para a barra de filtros (marcas, intervalo de preço, especificações) no contexto atual. */
  async facets(q: ListProductsQuery) {
    const where = await buildWhere({ ...q, brand: undefined, minPrice: undefined, maxPrice: undefined, spec: undefined, color: undefined, option: undefined });
    const [price, brands, specs] = await Promise.all([
      prisma.product.aggregate({ where, _min: { minPrice: true }, _max: { maxPrice: true } }),
      prisma.product.groupBy({ by: ['brandId'], where: { AND: [where, { brandId: { not: null } }] }, _count: { _all: true } }),
      prisma.productSpecification.groupBy({
        by: ['key', 'value'],
        where: { isFilterable: true, product: where },
        _count: { _all: true },
        orderBy: { _count: { productId: 'desc' } },
        take: 200,
      }),
    ]);
    const brandRows = await prisma.brand.findMany({
      where: { id: { in: brands.map((b) => b.brandId!).filter(Boolean) } },
      select: { id: true, name: true, slug: true },
    });
    // Opções de variantes (cor, armazenamento…) dos produtos filtrados — alimenta os filtros color/option.
    const productIds = (await prisma.product.findMany({ where, select: { id: true }, take: 5000 })).map((p) => p.id);
    const optionRows = productIds.length
      ? await prisma.$queryRaw<Array<{ key: string; value: string; count: bigint }>>`
          SELECT o.key, o.value, COUNT(DISTINCT v."productId")::bigint AS count
          FROM "product_variants" v, jsonb_each_text(v."options") o
          WHERE v."deletedAt" IS NULL AND v."isActive" AND v."productId" = ANY(${productIds}::uuid[])
          GROUP BY o.key, o.value ORDER BY o.key, count DESC`
      : [];
    const optionGroups = new Map<string, Array<{ value: string; count: number }>>();
    for (const o of optionRows) optionGroups.set(o.key, [...(optionGroups.get(o.key) ?? []), { value: o.value, count: Number(o.count) }]);

    const specGroups = new Map<string, Array<{ value: string; count: number }>>();
    for (const s of specs) specGroups.set(s.key, [...(specGroups.get(s.key) ?? []), { value: s.value, count: s._count._all }]);

    return {
      price: { min: price._min.minPrice ?? 0, max: price._max.maxPrice ?? 0 },
      brands: brandRows
        .map((b) => ({ ...b, count: brands.find((x) => x.brandId === b.id)?._count._all ?? 0 }))
        .sort((a, b) => b.count - a.count),
      specifications: [...specGroups.entries()].map(([key, values]) => ({ key, values })),
      options: [...optionGroups.entries()].map(([key, values]) => ({ key, values })),
    };
  }

  async getByIdOrSlug(by: { id?: string; slug?: string }) {
    const product = await prisma.product.findFirst({
      where: {
        ...(by.id ? { id: by.id } : { slug: by.slug }),
        deletedAt: null,
        // descontinuados continuam acessíveis por link (sem poderem ser comprados)
        status: { in: [...PUBLIC_STATUSES, ProductStatus.DISCONTINUED] },
      },
      include: {
        brand: { select: { id: true, name: true, slug: true, logoUrl: true } },
        category: { select: { id: true, name: true, slug: true } },
        images: { orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }], select: { id: true, url: true, thumbnailUrl: true, altText: true, isMain: true, variantId: true, width: true, height: true } },
        specifications: { orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }], select: { group: true, key: true, value: true, unit: true } },
        tags: { select: { tag: { select: { name: true, slug: true } } } },
        variants: {
          where: { deletedAt: null, isActive: true },
          orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
          include: { inventory: { select: { quantity: true, reserved: true } } },
        },
      },
    });
    if (!product) throw Errors.notFound('Product');

    // Contagem de visualizações sem bloquear a resposta.
    void prisma.product.update({ where: { id: product.id }, data: { viewCount: { increment: 1 } } }).catch(() => undefined);

    const promotions = await getActivePromotions();
    const purchasable = product.status === ProductStatus.ACTIVE;
    const variants = product.variants.map((v) => {
      const price = resolvePrice(v, product, promotions);
      const available = Math.max(0, (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0));
      return {
        id: v.id,
        sku: v.sku,
        name: v.name,
        options: v.options as Record<string, string>,
        isDefault: v.isDefault,
        price: { currency: product.currency, unit: price.unitPrice, compareAt: price.compareAtPrice > price.unitPrice ? price.compareAtPrice : null, discountPercent: price.discountPercent },
        promotion: price.promotion,
        stock: {
          level: purchasable ? stockLevel(available) : ('OUT_OF_STOCK' as const),
          maxPurchasable: purchasable ? Math.min(available, env.CART_MAX_QTY_PER_ITEM) : 0,
        },
        imageId: product.images.find((i) => i.variantId === v.id)?.id ?? null,
        physical: { weightGrams: v.weightGrams, heightMm: v.heightMm, widthMm: v.widthMm, lengthMm: v.lengthMm },
      };
    });

    // Eixos de opções (ex.: color: [Preto, Branco], storage: [128GB, 256GB]) para o seletor.
    const optionAxes: Record<string, string[]> = {};
    for (const v of variants) for (const [k, val] of Object.entries(v.options)) optionAxes[k] = [...new Set([...(optionAxes[k] ?? []), val])];

    const specGroups: Record<string, Array<{ key: string; value: string; unit: string | null }>> = {};
    for (const s of product.specifications) (specGroups[s.group ?? 'Geral'] ??= []).push({ key: s.key, value: s.value, unit: s.unit });

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      status: product.status,
      purchasable,
      shortDescription: product.shortDescription,
      description: product.description,
      brand: product.brand,
      category: product.category,
      tags: product.tags.map((t) => t.tag),
      currency: product.currency,
      price: { from: product.minPrice, to: product.maxPrice, discountPercent: product.maxDiscountPercent },
      rating: { average: Math.round(product.ratingAvg * 10) / 10, count: product.ratingCount },
      soldCount: product.soldCount,
      flags: { featured: product.isFeatured, new: product.isNew, onSale: product.isOnSale, recommended: product.isRecommended },
      warranty: product.hasWarranty ? { months: product.warrantyMonths, terms: product.warrantyTerms } : null,
      images: product.images,
      optionAxes,
      variants,
      specifications: Object.entries(specGroups).map(([group, items]) => ({ group, items })),
      seo: {
        metaTitle: product.metaTitle ?? product.name,
        metaDescription: product.metaDescription ?? product.shortDescription,
        canonicalUrl: product.canonicalUrl ?? frontendLinks.product(product.slug),
      },
    };
  }

  async featured(limit: number) {
    return this.list({ page: 1, limit, featured: true, sort: 'newest' } as ListProductsQuery);
  }

  async onSale(page: number, limit: number) {
    return this.list({ page, limit, onSale: true, sort: 'discount' } as ListProductsQuery);
  }

  async bestSellers(page: number, limit: number) {
    return this.list({ page, limit, sort: 'best_selling' } as ListProductsQuery);
  }

  /** Relacionados: explícitos (admin) com fallback; "ALSO_BOUGHT" calculado dos pedidos. */
  async related(productId: string, type: string, limit: number) {
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, categoryId: true, brandId: true } });
    if (!product) throw Errors.notFound('Product');
    const visible = { deletedAt: null, status: { in: PUBLIC_STATUSES }, id: { not: productId } };

    let ids: string[] = [];
    if (type === 'ALSO_BOUGHT') {
      const rows = await prisma.$queryRaw<{ productId: string }[]>`
        SELECT oi2."productId"::text AS "productId", COUNT(*) AS c
        FROM "order_items" oi1
        JOIN "order_items" oi2 ON oi2."orderId" = oi1."orderId" AND oi2."productId" <> oi1."productId"
        JOIN "orders" o ON o."id" = oi1."orderId" AND o."status" NOT IN (${OrderStatus.CANCELLED}::"OrderStatus", ${OrderStatus.PENDING}::"OrderStatus")
        WHERE oi1."productId" = ${productId}::uuid AND oi2."productId" IS NOT NULL
        GROUP BY oi2."productId" ORDER BY c DESC LIMIT ${limit * 2}`;
      ids = rows.map((r) => r.productId);
    } else {
      const rel = await prisma.productRelation.findMany({
        where: { productId, type: type as ProductRelationType },
        orderBy: { sortOrder: 'asc' },
        select: { relatedProductId: true },
        take: limit * 2,
      });
      ids = rel.map((r) => r.relatedProductId);
    }

    const explicit = ids.length
      ? await prisma.product.findMany({ where: { ...visible, id: { in: ids, not: productId } }, select: cardSelect })
      : [];
    const ordered = ids.map((id) => explicit.find((p) => p.id === id)).filter((p): p is CardRow => Boolean(p)).slice(0, limit);

    // Fallback para "semelhantes": mesma categoria, mais vendidos.
    if (ordered.length < limit && (type === 'SIMILAR' || type === 'ALSO_BOUGHT' || type === 'RECOMMENDED')) {
      const fill = await prisma.product.findMany({
        where: { ...visible, categoryId: product.categoryId, id: { notIn: [productId, ...ordered.map((p) => p.id)] } },
        select: cardSelect,
        orderBy: [{ soldCount: 'desc' }, { ratingAvg: 'desc' }],
        take: limit - ordered.length,
      });
      ordered.push(...fill);
    }
    return ordered.map(toCard);
  }
}

export type { PromotionRule };
