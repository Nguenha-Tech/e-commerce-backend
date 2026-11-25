import { DiscountType } from '../../db/client';

/**
 * Motor de preços CENTRAL (função pura, sem I/O) — usado pelo carrinho, pelo resumo do
 * checkout e pela criação do pedido, garantindo que os três calculam exatamente o mesmo.
 *
 *   subtotal (preço efetivo × qtd)
 * − cupão
 * + entrega
 * + IVA (só se os preços NÃO incluírem IVA; caso contrário é apenas discriminado)
 * = total
 *
 * Todos os valores são inteiros em centavos.
 */

export interface PricingLineInput {
  variantId: string;
  productId: string;
  categoryId: string;
  quantity: number;
  /** Preço unitário efetivo (já com promoções do catálogo). */
  unitPrice: number;
  /** Preço "riscado" (para calcular desconto de produto). */
  compareAtPrice: number;
}

export interface CouponRule {
  id: string;
  code: string;
  discountType: DiscountType;
  value: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number | null;
  applicableProductIds: string[];
  applicableCategoryIds: string[];
}

export interface TaxConfig {
  ratePercent: number;
  included: boolean;
}

export interface PricingInput {
  lines: PricingLineInput[];
  coupon?: CouponRule | null;
  /** Preço da entrega já calculado (null = ainda não escolhida). */
  shippingPrice?: number | null;
  tax: TaxConfig;
}

export interface PricedLine extends PricingLineInput {
  lineSubtotal: number;
  productDiscount: number;
  couponDiscount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface CouponOutcome {
  code: string;
  applied: boolean;
  reason?: 'MIN_ORDER_NOT_MET' | 'NO_ELIGIBLE_ITEMS';
  discount: number;
  freeShipping: boolean;
}

export interface PricingResult {
  lines: PricedLine[];
  itemsCount: number;
  subtotal: number;
  productDiscount: number;
  couponDiscount: number;
  shippingTotal: number | null;
  shippingDiscount: number;
  taxTotal: number;
  taxIncluded: boolean;
  grandTotal: number;
  coupon: CouponOutcome | null;
}

/** Distribui `amount` pelas linhas proporcionalmente ao peso (maior resto recebe os cêntimos). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const floored = raw.map(Math.floor);
  let remainder = amount - floored.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (remainder <= 0) break;
    floored[i]! += 1;
    remainder -= 1;
  }
  return floored;
}

function isEligible(line: PricingLineInput, coupon: CouponRule) {
  const anyRestriction = coupon.applicableProductIds.length > 0 || coupon.applicableCategoryIds.length > 0;
  if (!anyRestriction) return true;
  return coupon.applicableProductIds.includes(line.productId) || coupon.applicableCategoryIds.includes(line.categoryId);
}

export function taxFromAmount(amount: number, tax: TaxConfig): number {
  if (tax.ratePercent <= 0 || amount <= 0) return 0;
  const r = tax.ratePercent / 100;
  return tax.included ? Math.round(amount - amount / (1 + r)) : Math.round(amount * r);
}

export function calculateTotals(input: PricingInput): PricingResult {
  const base = input.lines.map((l) => {
    const lineSubtotal = l.unitPrice * l.quantity;
    const productDiscount = Math.max(0, l.compareAtPrice - l.unitPrice) * l.quantity;
    return { ...l, lineSubtotal, productDiscount };
  });
  const subtotal = base.reduce((s, l) => s + l.lineSubtotal, 0);

  // ----- cupão
  let couponDiscounts = base.map(() => 0);
  let coupon: CouponOutcome | null = null;
  let freeShipping = false;
  if (input.coupon) {
    const c = input.coupon;
    const eligible = base.map((l) => (isEligible(l, c) ? l.lineSubtotal : 0));
    const eligibleSubtotal = eligible.reduce((a, b) => a + b, 0);
    if (c.minOrderAmount && subtotal < c.minOrderAmount) {
      coupon = { code: c.code, applied: false, reason: 'MIN_ORDER_NOT_MET', discount: 0, freeShipping: false };
    } else if (eligibleSubtotal === 0) {
      coupon = { code: c.code, applied: false, reason: 'NO_ELIGIBLE_ITEMS', discount: 0, freeShipping: false };
    } else {
      let discount = 0;
      if (c.discountType === DiscountType.PERCENTAGE) discount = Math.floor((eligibleSubtotal * Math.min(c.value, 100)) / 100);
      else if (c.discountType === DiscountType.FIXED_AMOUNT) discount = c.value;
      else freeShipping = true;
      if (c.maxDiscountAmount != null) discount = Math.min(discount, c.maxDiscountAmount);
      discount = Math.min(discount, eligibleSubtotal);
      couponDiscounts = allocate(discount, eligible);
      coupon = { code: c.code, applied: true, discount, freeShipping };
    }
  }
  const couponDiscount = couponDiscounts.reduce((a, b) => a + b, 0);

  // ----- entrega
  const rawShipping = input.shippingPrice ?? null;
  const shippingDiscount = freeShipping && rawShipping ? rawShipping : 0;
  const shippingTotal = rawShipping === null ? null : rawShipping - shippingDiscount;

  // ----- impostos (sobre o valor efetivamente pago pelos produtos)
  const lines: PricedLine[] = base.map((l, i) => {
    const net = l.lineSubtotal - couponDiscounts[i]!;
    const taxAmount = taxFromAmount(net, input.tax);
    return { ...l, couponDiscount: couponDiscounts[i]!, taxAmount, lineTotal: net + (input.tax.included ? 0 : taxAmount) };
  });
  const taxTotal = lines.reduce((s, l) => s + l.taxAmount, 0);

  const grandTotal = subtotal - couponDiscount + (shippingTotal ?? 0) + (input.tax.included ? 0 : taxTotal);

  return {
    lines,
    itemsCount: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal,
    productDiscount: base.reduce((s, l) => s + l.productDiscount, 0),
    couponDiscount,
    shippingTotal,
    shippingDiscount,
    taxTotal,
    taxIncluded: input.tax.included,
    grandTotal,
    coupon,
  };
}
