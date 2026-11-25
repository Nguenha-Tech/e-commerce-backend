import { DiscountType, prisma, PromotionScope, type PromotionKind } from '../../db/client';
import { TtlCache } from '../../utils/cache';
import { discountPercent } from '../../utils/money';

/**
 * Fonte ÚNICA do preço efetivo de uma variante (catálogo, carrinho e checkout usam isto).
 * Ordem: preço de venda → preço promocional da variante (se na janela) → promoções ativas
 * (produto / categoria / marca / loja). Ganha o menor preço para o cliente.
 */

export interface PromotionRule {
  id: string;
  name: string;
  kind: PromotionKind;
  scope: PromotionScope;
  discountType: DiscountType;
  value: number;
  productIds: string[];
  categoryIds: string[];
  brandIds: string[];
  priority: number;
  endsAt: Date;
}

export interface VariantPricing {
  price: number;
  originalPrice: number;
  promoPrice: number | null;
  promoStartsAt: Date | null;
  promoEndsAt: Date | null;
}

export interface ProductRef {
  id: string;
  categoryId: string;
  brandId: string | null;
}

export interface ResolvedPrice {
  /** Preço unitário a cobrar. */
  unitPrice: number;
  /** Preço "riscado" para mostrar. */
  compareAtPrice: number;
  discountPercent: number;
  promotion: { id: string; name: string; kind: PromotionKind; endsAt: Date } | null;
}

const promoCache = new TtlCache<PromotionRule[]>(30_000);

export async function getActivePromotions(now = new Date()): Promise<PromotionRule[]> {
  return promoCache.getOrSet('active', () =>
    prisma.promotion.findMany({
      where: { isActive: true, deletedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
      select: {
        id: true, name: true, kind: true, scope: true, discountType: true, value: true,
        productIds: true, categoryIds: true, brandIds: true, priority: true, endsAt: true,
      },
      orderBy: { priority: 'desc' },
    }),
  );
}

export const invalidatePromotionCache = () => promoCache.clear();

function applies(rule: PromotionRule, product: ProductRef): boolean {
  switch (rule.scope) {
    case PromotionScope.STOREWIDE:
      return true;
    case PromotionScope.PRODUCT:
      return rule.productIds.includes(product.id);
    case PromotionScope.CATEGORY:
      return rule.categoryIds.includes(product.categoryId);
    case PromotionScope.BRAND:
      return product.brandId !== null && rule.brandIds.includes(product.brandId);
    default:
      return false;
  }
}

function applyRule(base: number, rule: PromotionRule): number {
  if (rule.discountType === DiscountType.PERCENTAGE) return Math.max(0, base - Math.floor((base * Math.min(rule.value, 100)) / 100));
  if (rule.discountType === DiscountType.FIXED_AMOUNT) return Math.max(0, base - rule.value);
  return base; // FREE_SHIPPING não altera o preço do produto
}

export function resolvePrice(
  variant: VariantPricing,
  product: ProductRef,
  promotions: PromotionRule[],
  now = new Date(),
): ResolvedPrice {
  let unitPrice = variant.price;
  let promotion: ResolvedPrice['promotion'] = null;

  const promoWindowOpen =
    variant.promoPrice != null &&
    (!variant.promoStartsAt || variant.promoStartsAt <= now) &&
    (!variant.promoEndsAt || variant.promoEndsAt > now);
  if (promoWindowOpen && variant.promoPrice! < unitPrice) unitPrice = variant.promoPrice!;

  for (const rule of promotions) {
    if (!applies(rule, product)) continue;
    const candidate = applyRule(variant.price, rule);
    if (candidate < unitPrice) {
      unitPrice = candidate;
      promotion = { id: rule.id, name: rule.name, kind: rule.kind, endsAt: rule.endsAt };
    }
  }

  const compareAtPrice = Math.max(variant.originalPrice, variant.price);
  return { unitPrice, compareAtPrice, discountPercent: discountPercent(compareAtPrice, unitPrice), promotion };
}
