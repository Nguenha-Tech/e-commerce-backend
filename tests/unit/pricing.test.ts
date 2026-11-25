import { describe, expect, it } from 'vitest';
import { resolvePrice, type PromotionRule } from '../../src/modules/products/price-resolver';
import { allocate, calculateTotals } from '../../src/modules/orders/pricing';

const variant = { price: 100_000, originalPrice: 120_000, promoPrice: null, promoStartsAt: null, promoEndsAt: null };
const product = { id: 'p1', categoryId: 'c1', brandId: 'b1' };
const promo = (over: Partial<PromotionRule>): PromotionRule => ({
  id: 'x', name: 'Promo', kind: 'REGULAR', scope: 'STOREWIDE', discountType: 'PERCENTAGE', value: 10, productIds: [], categoryIds: [], brandIds: [], priority: 0, endsAt: new Date(Date.now() + 1e6), ...over,
});

describe('preço efetivo (price-resolver)', () => {
  it('sem promoções usa o preço de venda e o preço original como riscado', () => {
    const r = resolvePrice(variant, product, []);
    expect(r.unitPrice).toBe(100_000);
    expect(r.compareAtPrice).toBe(120_000);
    expect(r.discountPercent).toBe(17);
  });

  it('ganha o menor preço entre promoções aplicáveis', () => {
    const r = resolvePrice(variant, product, [promo({ value: 10 }), promo({ id: 'y', scope: 'BRAND', brandIds: ['b1'], value: 30 }), promo({ id: 'z', scope: 'CATEGORY', categoryIds: ['other'], value: 90 })]);
    expect(r.unitPrice).toBe(70_000);
    expect(r.promotion?.id).toBe('y');
  });

  it('preço promocional da variante só dentro da janela', () => {
    const past = { ...variant, promoPrice: 50_000, promoEndsAt: new Date(Date.now() - 1000) };
    expect(resolvePrice(past, product, []).unitPrice).toBe(100_000);
    const active = { ...variant, promoPrice: 50_000, promoStartsAt: new Date(Date.now() - 1000) };
    expect(resolvePrice(active, product, []).unitPrice).toBe(50_000);
  });
});

describe('motor de totais (pricing)', () => {
  const line = (unitPrice: number, quantity: number, id = 'v1') => ({ variantId: id, productId: `p-${id}`, categoryId: 'c1', quantity, unitPrice, compareAtPrice: unitPrice });

  it('allocate distribui sem perder centavos', () => {
    const parts = allocate(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('total = subtotal − cupão + entrega (IVA incluído só discriminado)', () => {
    const r = calculateTotals({
      lines: [line(100_000, 2)],
      coupon: { id: 'c', code: 'TECH10', discountType: 'PERCENTAGE', value: 10, maxDiscountAmount: null, minOrderAmount: 50_000, applicableProductIds: [], applicableCategoryIds: [] },
      shippingPrice: 30_000,
      tax: { ratePercent: 16, included: true },
    });
    expect(r.subtotal).toBe(200_000);
    expect(r.couponDiscount).toBe(20_000);
    expect(r.grandTotal).toBe(210_000);
    expect(r.taxTotal).toBeGreaterThan(0);
  });

  it('cupão abaixo do mínimo não é aplicado', () => {
    const r = calculateTotals({
      lines: [line(10_000, 1)],
      coupon: { id: 'c', code: 'TECH10', discountType: 'PERCENTAGE', value: 10, maxDiscountAmount: null, minOrderAmount: 500_000, applicableProductIds: [], applicableCategoryIds: [] },
      shippingPrice: 0,
      tax: { ratePercent: 16, included: true },
    });
    expect(r.couponDiscount).toBe(0);
    expect(r.coupon?.applied).toBe(false);
  });
});
