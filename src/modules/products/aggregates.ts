import { prisma, ProductStatus, type Db } from '../../db/client';
import { getActivePromotions, resolvePrice } from './price-resolver';

/**
 * Recalcula os campos desnormalizados do produto (minPrice, desconto, stock disponível…)
 * usados em listagens/filtros/ordenação, e alterna ACTIVE <-> OUT_OF_STOCK automaticamente.
 */
export async function refreshProductAggregates(productId: string, db: Db = prisma): Promise<void> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      categoryId: true,
      brandId: true,
      status: true,
      variants: {
        where: { deletedAt: null, isActive: true },
        select: {
          price: true,
          originalPrice: true,
          promoPrice: true,
          promoStartsAt: true,
          promoEndsAt: true,
          inventory: { select: { quantity: true, reserved: true } },
        },
      },
    },
  });
  if (!product) return;

  const promotions = await getActivePromotions();
  const prices = product.variants.map((v) => resolvePrice(v, product, promotions));
  const available = product.variants.reduce((sum, v) => sum + Math.max(0, (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0)), 0);
  const maxDiscount = prices.reduce((m, p) => Math.max(m, p.discountPercent), 0);

  let status = product.status;
  if (status === ProductStatus.ACTIVE && available === 0) status = ProductStatus.OUT_OF_STOCK;
  else if (status === ProductStatus.OUT_OF_STOCK && available > 0) status = ProductStatus.ACTIVE;

  await db.product.update({
    where: { id: productId },
    data: {
      minPrice: prices.length ? Math.min(...prices.map((p) => p.unitPrice)) : 0,
      maxPrice: prices.length ? Math.max(...prices.map((p) => p.unitPrice)) : 0,
      maxDiscountPercent: maxDiscount,
      isOnSale: maxDiscount > 0,
      availableStock: available,
      status,
    },
  });
}

/** Atualização fora da transação principal (não bloqueia o checkout) e tolerante a falhas. */
export async function refreshManyProductAggregates(productIds: Iterable<string>): Promise<void> {
  for (const id of new Set(productIds)) {
    try {
      await refreshProductAggregates(id);
    } catch (err) {
      console.error('aggregate refresh failed', { productId: id, err: (err as Error).message });
    }
  }
}
