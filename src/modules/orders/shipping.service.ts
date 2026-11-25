import { prisma, ShippingMethodType } from '../../db/client';
import { Errors } from '../../utils/errors';

export interface ShippingAddressLike {
  country: string;
  province: string;
  city: string;
}

export interface ShippingContext {
  subtotal: number;
  weightGrams: number;
}

export interface ShippingOption {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: ShippingMethodType;
  carrier: string | null;
  price: number;
  freeShippingApplied: boolean;
  estimatedDays: { min: number; max: number };
  requiresAddress: boolean;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

type MethodRow = Awaited<ReturnType<typeof loadMethods>>[number];

function loadMethods(code?: string) {
  return prisma.shippingMethod.findMany({
    where: { isActive: true, ...(code ? { code } : {}) },
    include: { rates: { where: { isActive: true } } },
    orderBy: { sortOrder: 'asc' },
  });
}

/** Preço para a morada: tarifa mais específica (cidade > província > país) ou preço base. */
function priceFor(method: MethodRow, address: ShippingAddressLike | null, ctx: ShippingContext): ShippingOption | null {
  let price = method.basePrice;
  let days = { min: method.estimatedDaysMin, max: method.estimatedDaysMax };

  if (method.type !== ShippingMethodType.PICKUP) {
    if (!address) return null;
    if (method.rates.length > 0) {
      const matches = method.rates
        .filter(
          (r) =>
            norm(r.country) === norm(address.country) &&
            (!r.province || norm(r.province) === norm(address.province)) &&
            (!r.city || norm(r.city) === norm(address.city)),
        )
        .sort((a, b) => Number(Boolean(b.city)) * 2 + Number(Boolean(b.province)) - (Number(Boolean(a.city)) * 2 + Number(Boolean(a.province))));
      const rate = matches[0];
      if (!rate) return null; // método não cobre esta região
      price = rate.price;
      days = { min: rate.estimatedDaysMin ?? days.min, max: rate.estimatedDaysMax ?? days.max };
    }
    // Sobretaxa por kg acima do primeiro.
    const extraKg = Math.max(0, Math.ceil(ctx.weightGrams / 1000) - 1);
    price += extraKg * method.pricePerKg;
  }

  const freeShippingApplied = method.freeShippingThreshold != null && ctx.subtotal >= method.freeShippingThreshold;
  return {
    id: method.id,
    code: method.code,
    name: method.name,
    description: method.description,
    type: method.type,
    carrier: method.carrier,
    price: freeShippingApplied ? 0 : price,
    freeShippingApplied,
    estimatedDays: days,
    requiresAddress: method.type !== ShippingMethodType.PICKUP,
  };
}

export class ShippingService {
  async options(address: ShippingAddressLike | null, ctx: ShippingContext): Promise<ShippingOption[]> {
    const methods = await loadMethods();
    return methods.map((m) => priceFor(m, address, ctx)).filter((o): o is ShippingOption => o !== null);
  }

  async quote(code: string, address: ShippingAddressLike | null, ctx: ShippingContext): Promise<ShippingOption> {
    const [method] = await loadMethods(code);
    if (!method) throw Errors.unprocessable('SHIPPING_METHOD_INVALID', 'Shipping method is not available');
    if (method.type !== ShippingMethodType.PICKUP && !address) throw Errors.badRequest('ADDRESS_REQUIRED', 'A delivery address is required');
    const option = priceFor(method, address, ctx);
    if (!option) throw Errors.unprocessable('SHIPPING_UNAVAILABLE_FOR_REGION', 'This shipping method does not deliver to the selected address');
    return option;
  }
}
