import { env } from '../../config/env';
import { prisma, ProductStatus } from '../../db/client';
import { randomToken, sha256 } from '../../utils/crypto';
import { AppError, Errors } from '../../utils/errors';
import { loadCoupon } from './coupons';
import { resolveLines, type ResolvedLine } from './lines';
import { calculateTotals, type CouponRule } from './pricing';
import { ShippingService } from './shipping.service';

const MAX_LINES = 50;

/** Identidade do carrinho: utilizador autenticado OU token de visitante (cookie). */
export type CartOwner = { userId: string } | { guestToken: string };

export const taxConfig = () => ({ ratePercent: env.TAX_RATE_PERCENT, included: env.TAX_INCLUDED_IN_PRICES });

function ownerWhere(owner: CartOwner) {
  return 'userId' in owner ? { userId: owner.userId } : { guestTokenHash: sha256(owner.guestToken) };
}

async function findCart(owner: CartOwner) {
  const cart = await prisma.cart.findFirst({ where: ownerWhere(owner), include: { items: { orderBy: { createdAt: 'asc' } } } });
  if (cart && cart.expiresAt && cart.expiresAt < new Date()) {
    await prisma.cart.delete({ where: { id: cart.id } }).catch(() => undefined);
    return null;
  }
  return cart;
}

/** Cria o carrinho se não existir. Para visitantes devolve também um token novo (cookie). */
async function ensureCart(owner: CartOwner | null): Promise<{ cartId: string; newGuestToken?: string }> {
  if (owner) {
    const existing = await findCart(owner);
    if (existing) return { cartId: existing.id };
    if ('userId' in owner) {
      const cart = await prisma.cart.upsert({ where: { userId: owner.userId }, update: {}, create: { userId: owner.userId } });
      return { cartId: cart.id };
    }
  }
  const token = randomToken(32);
  const cart = await prisma.cart.create({
    data: { guestTokenHash: sha256(token), expiresAt: new Date(Date.now() + env.CART_GUEST_TTL_DAYS * 86_400_000) },
  });
  return { cartId: cart.id, newGuestToken: token };
}

async function assertSellable(variantId: string, desiredQty: number) {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, deletedAt: null, isActive: true, product: { deletedAt: null, status: ProductStatus.ACTIVE } },
    select: { sku: true, inventory: { select: { quantity: true, reserved: true } } },
  });
  if (!variant) throw Errors.unprocessable('PRODUCT_UNAVAILABLE', 'Product is not available for purchase');
  const available = Math.max(0, (variant.inventory?.quantity ?? 0) - (variant.inventory?.reserved ?? 0));
  if (desiredQty > env.CART_MAX_QTY_PER_ITEM) {
    throw Errors.unprocessable('QUANTITY_LIMIT_EXCEEDED', `Maximum ${env.CART_MAX_QTY_PER_ITEM} units per item`, { max: env.CART_MAX_QTY_PER_ITEM });
  }
  if (desiredQty > available) {
    throw Errors.conflict('INSUFFICIENT_STOCK', `Only ${available} unit(s) available`, { variantId, sku: variant.sku, available, requested: desiredQty });
  }
}

export interface CartSummaryOptions {
  shippingMethodCode?: string;
  address?: { country: string; province: string; city: string } | null;
}

export class CartService {
  private shipping = new ShippingService();

  async summary(owner: CartOwner | null, userId: string | null, opts: CartSummaryOptions = {}) {
    const cart = owner ? await findCart(owner) : null;
    if (!cart) return emptySummary();

    const lines = await resolveLines(cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })));
    const itemIdByVariant = new Map(cart.items.map((i) => [i.variantId, i.id]));
    const valid = lines.filter((l) => !l.issue);

    let coupon: CouponRule | null = null;
    let couponError: { code: string; message: string } | null = null;
    if (cart.couponCode) {
      try {
        coupon = await loadCoupon(cart.couponCode, userId);
      } catch (err) {
        if (err instanceof AppError) couponError = { code: err.errorCode, message: err.message };
        else throw err;
      }
    }

    const subtotal = valid.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
    let shipping = null;
    if (opts.shippingMethodCode && valid.length) {
      shipping = await this.shipping
        .quote(opts.shippingMethodCode, opts.address ?? null, { subtotal, weightGrams: valid.reduce((s, l) => s + l.weightGrams, 0) })
        .catch(() => null);
    }

    const totals = calculateTotals({ lines: valid, coupon, shippingPrice: shipping?.price ?? null, tax: taxConfig() });
    return {
      id: cart.id,
      currency: lines[0]?.currency ?? env.DEFAULT_CURRENCY,
      items: lines.map((l) => toCartItem(l, itemIdByVariant.get(l.variantId)!)),
      couponCode: cart.couponCode,
      couponStatus: cart.couponCode ? (couponError ? { applied: false, ...couponError } : totals.coupon) : null,
      shipping: shipping && { code: shipping.code, name: shipping.name, price: shipping.price, estimatedDays: shipping.estimatedDays },
      totals: {
        itemsCount: totals.itemsCount,
        subtotal: totals.subtotal,
        productDiscount: totals.productDiscount,
        couponDiscount: totals.couponDiscount,
        shipping: totals.shippingTotal,
        tax: totals.taxTotal,
        taxIncluded: totals.taxIncluded,
        total: totals.grandTotal,
      },
      hasIssues: lines.some((l) => l.issue),
    };
  }

  async addItem(owner: CartOwner | null, variantId: string, quantity: number) {
    const { cartId, newGuestToken } = await ensureCart(owner);
    const count = await prisma.cartItem.count({ where: { cartId } });
    const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
    if (!existing && count >= MAX_LINES) throw Errors.unprocessable('CART_LIMIT_REACHED', `Maximum ${MAX_LINES} different items`);
    const desired = (existing?.quantity ?? 0) + quantity;
    await assertSellable(variantId, desired);
    await prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId, variantId } },
      update: { quantity: desired },
      create: { cartId, variantId, quantity },
    });
    await touch(cartId);
    return { newGuestToken };
  }

  async updateItem(owner: CartOwner | null, itemId: string, quantity: number) {
    const item = await this.ownedItem(owner, itemId);
    await assertSellable(item.variantId, quantity);
    await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
    await touch(item.cartId);
  }

  async removeItem(owner: CartOwner | null, itemId: string) {
    const item = await this.ownedItem(owner, itemId);
    await prisma.cartItem.delete({ where: { id: item.id } });
  }

  async clear(owner: CartOwner | null) {
    const cart = owner ? await findCart(owner) : null;
    if (cart) await prisma.$transaction([prisma.cartItem.deleteMany({ where: { cartId: cart.id } }), prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } })]);
  }

  async applyCoupon(owner: CartOwner | null, userId: string | null, code: string) {
    const cart = owner ? await findCart(owner) : null;
    if (!cart || cart.items.length === 0) throw Errors.unprocessable('CART_EMPTY', 'Your cart is empty');
    const coupon = await loadCoupon(code, userId); // lança erro com o motivo
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: coupon.code } });
  }

  async removeCoupon(owner: CartOwner | null) {
    const cart = owner ? await findCart(owner) : null;
    if (cart) await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
  }

  private async ownedItem(owner: CartOwner | null, itemId: string) {
    const cart = owner ? await findCart(owner) : null;
    const item = cart?.items.find((i) => i.id === itemId);
    if (!cart || !item) throw Errors.notFound('Cart item');
    return { ...item, cartId: cart.id };
  }
}

/** Login/registo: soma o carrinho de visitante ao do utilizador (limitado ao stock) e apaga-o. */
export async function mergeGuestCart(userId: string, guestToken: string): Promise<void> {
  const guest = await findCart({ guestToken });
  if (!guest) return;
  if (guest.items.length > 0) {
    const userCart = await prisma.cart.upsert({ where: { userId }, update: {}, create: { userId }, include: { items: true } });
    const lines = await resolveLines(guest.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })));
    for (const g of guest.items) {
      const line = lines.find((l) => l.variantId === g.variantId);
      if (!line || line.issue?.code === 'UNAVAILABLE') continue;
      const current = userCart.items.find((i) => i.variantId === g.variantId)?.quantity ?? 0;
      const quantity = Math.min(current + g.quantity, line.available, env.CART_MAX_QTY_PER_ITEM);
      if (quantity <= 0) continue;
      await prisma.cartItem.upsert({
        where: { cartId_variantId: { cartId: userCart.id, variantId: g.variantId } },
        update: { quantity },
        create: { cartId: userCart.id, variantId: g.variantId, quantity },
      });
    }
    if (guest.couponCode && !userCart.couponCode) await prisma.cart.update({ where: { id: userCart.id }, data: { couponCode: guest.couponCode } });
  }
  await prisma.cart.delete({ where: { id: guest.id } });
}

async function touch(cartId: string) {
  await prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
}

function toCartItem(l: ResolvedLine, itemId: string) {
  return {
    id: itemId,
    variantId: l.variantId,
    productId: l.productId,
    name: l.productName,
    slug: l.productSlug,
    sku: l.sku,
    variantName: l.variantName,
    options: l.options,
    image: l.imageUrl,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    compareAtPrice: l.compareAtPrice > l.unitPrice ? l.compareAtPrice : null,
    discountPercent: l.discountPercent,
    lineTotal: l.unitPrice * l.quantity,
    maxPurchasable: Math.min(l.available, env.CART_MAX_QTY_PER_ITEM),
    issue: l.issue,
  };
}

function emptySummary() {
  return {
    id: null,
    currency: env.DEFAULT_CURRENCY,
    items: [],
    couponCode: null,
    couponStatus: null,
    shipping: null,
    totals: { itemsCount: 0, subtotal: 0, productDiscount: 0, couponDiscount: 0, shipping: null, tax: 0, taxIncluded: env.TAX_INCLUDED_IN_PRICES, total: 0 },
    hasIssues: false,
  };
}
