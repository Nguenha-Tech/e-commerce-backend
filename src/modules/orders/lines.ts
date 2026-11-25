import { env } from '../../config/env';
import { prisma, ProductStatus, type Db } from '../../db/client';
import { getActivePromotions, resolvePrice } from '../products/price-resolver';

/**
 * Resolve itens {variantId, quantity} contra o catálogo ATUAL: preço efetivo, stock,
 * disponibilidade e dados de snapshot. Usado pelo carrinho e pelo checkout.
 */

export interface RequestedItem {
  variantId: string;
  quantity: number;
}

export type LineIssueCode = 'UNAVAILABLE' | 'INSUFFICIENT_STOCK' | 'QUANTITY_LIMIT';

export interface ResolvedLine {
  variantId: string;
  productId: string;
  categoryId: string;
  brandName: string | null;
  productName: string;
  productSlug: string;
  sku: string;
  variantName: string | null;
  options: Record<string, string>;
  imageUrl: string | null;
  quantity: number;
  unitPrice: number;
  compareAtPrice: number;
  discountPercent: number;
  costPrice: number | null;
  weightGrams: number;
  currency: string;
  available: number;
  issue: { code: LineIssueCode; message: string; available?: number } | null;
}

export async function resolveLines(items: RequestedItem[], db: Db = prisma): Promise<ResolvedLine[]> {
  if (items.length === 0) return [];
  const variants = await db.productVariant.findMany({
    where: { id: { in: items.map((i) => i.variantId) } },
    include: {
      inventory: { select: { quantity: true, reserved: true } },
      images: { select: { thumbnailUrl: true, url: true }, take: 1, orderBy: { sortOrder: 'asc' } },
      product: {
        select: {
          id: true, name: true, slug: true, status: true, deletedAt: true, categoryId: true, brandId: true, currency: true,
          brand: { select: { name: true } },
          images: { select: { thumbnailUrl: true, url: true }, orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }], take: 1 },
        },
      },
    },
  });
  const promotions = await getActivePromotions();

  return items.flatMap((item) => {
    const v = variants.find((x) => x.id === item.variantId);
    if (!v) return [];
    const p = v.product;
    const price = resolvePrice(v, { id: p.id, categoryId: p.categoryId, brandId: p.brandId }, promotions);
    const available = Math.max(0, (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0));
    const sellable = !v.deletedAt && v.isActive && !p.deletedAt && p.status === ProductStatus.ACTIVE;

    let issue: ResolvedLine['issue'] = null;
    if (!sellable) issue = { code: 'UNAVAILABLE', message: 'Product is no longer available' };
    else if (item.quantity > available) issue = { code: 'INSUFFICIENT_STOCK', message: `Only ${available} unit(s) available`, available };
    else if (item.quantity > env.CART_MAX_QTY_PER_ITEM) issue = { code: 'QUANTITY_LIMIT', message: `Max ${env.CART_MAX_QTY_PER_ITEM} units per item` };

    const image = v.images[0] ?? p.images[0];
    return [
      {
        variantId: v.id,
        productId: p.id,
        categoryId: p.categoryId,
        brandName: p.brand?.name ?? null,
        productName: p.name,
        productSlug: p.slug,
        sku: v.sku,
        variantName: v.name,
        options: v.options as Record<string, string>,
        imageUrl: image?.thumbnailUrl ?? image?.url ?? null,
        quantity: item.quantity,
        unitPrice: price.unitPrice,
        compareAtPrice: price.compareAtPrice,
        discountPercent: price.discountPercent,
        costPrice: v.costPrice,
        weightGrams: (v.packageWeightGrams ?? v.weightGrams ?? 0) * item.quantity,
        currency: p.currency,
        available,
        issue,
      },
    ];
  });
}
