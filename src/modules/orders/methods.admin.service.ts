import { z } from 'zod';
import { PaymentMethodType, prisma, Prisma, ShippingMethodType } from '../../db/client';
import { diffFields, recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { listPaymentProviders } from './payments/providers';

/* Métodos de entrega (com tarifas por região) e de pagamento — geridos pelo OWNER. */

// ------------------------------------------------------------------ schemas
const methodCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/);
const money = z.number().int().min(0);
const days = z.number().int().min(0).max(90);

const shippingFields = {
  code: methodCode,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable(),
  type: z.nativeEnum(ShippingMethodType),
  carrier: z.string().trim().max(80).nullable(),
  basePrice: money,
  pricePerKg: money,
  freeShippingThreshold: money.nullable(),
  estimatedDaysMin: days,
  estimatedDaysMax: days,
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};

export const createShippingMethodBody = z
  .object({
    ...shippingFields,
    description: shippingFields.description.optional(),
    carrier: shippingFields.carrier.optional(),
    pricePerKg: money.default(0),
    freeShippingThreshold: shippingFields.freeShippingThreshold.optional(),
    estimatedDaysMin: days.default(1),
    estimatedDaysMax: days.default(3),
    isActive: z.boolean().default(true),
    sortOrder: shippingFields.sortOrder.default(0),
  })
  .refine((m) => m.estimatedDaysMin <= m.estimatedDaysMax, { path: ['estimatedDaysMax'], message: 'estimatedDaysMax must be >= estimatedDaysMin' });

export const updateShippingMethodBody = z.object(shippingFields).partial().strict();

const rateFields = {
  country: z.string().trim().min(2).max(80),
  province: z.string().trim().max(80).nullable(),
  city: z.string().trim().max(80).nullable(),
  price: money,
  estimatedDaysMin: days.nullable(),
  estimatedDaysMax: days.nullable(),
  isActive: z.boolean(),
};
export const createShippingRateBody = z.object({
  ...rateFields,
  province: rateFields.province.optional(),
  city: rateFields.city.optional(),
  estimatedDaysMin: rateFields.estimatedDaysMin.optional(),
  estimatedDaysMax: rateFields.estimatedDaysMax.optional(),
  isActive: z.boolean().default(true),
});
export const updateShippingRateBody = z.object(rateFields).partial().strict();

/** Configuração pública do método (ex.: NIB para transferência). Segredos ficam em env. */
const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|private)/i;
const safeConfig = z
  .record(z.union([z.string().max(300), z.number(), z.boolean()]))
  .refine((c) => Object.keys(c).length <= 20, 'Too many keys')
  .refine((c) => !Object.keys(c).some((k) => SECRET_KEY.test(k)), 'Secrets must not be stored in payment method config — use environment variables')
  .nullable();

const paymentFields = {
  code: methodCode,
  name: z.string().trim().min(2).max(80),
  type: z.nativeEnum(PaymentMethodType),
  provider: z.string().trim().min(2).max(40),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
  instructions: z.string().trim().max(1000).nullable(),
  config: safeConfig,
};
export const createPaymentMethodBody = z.object({
  ...paymentFields,
  isActive: z.boolean().default(true),
  sortOrder: paymentFields.sortOrder.default(0),
  instructions: paymentFields.instructions.optional(),
  config: safeConfig.optional(),
});
export const updatePaymentMethodBody = z.object(paymentFields).partial().strict();

type CreateShipping = z.infer<typeof createShippingMethodBody>;
type UpdateShipping = z.infer<typeof updateShippingMethodBody>;
type CreateRate = z.infer<typeof createShippingRateBody>;
type UpdateRate = z.infer<typeof updateShippingRateBody>;
type CreatePayment = z.infer<typeof createPaymentMethodBody>;
type UpdatePayment = z.infer<typeof updatePaymentMethodBody>;

function assertProvider(code: string) {
  if (!listPaymentProviders().some((p) => p.code === code)) {
    throw Errors.unprocessable('PAYMENT_PROVIDER_UNAVAILABLE', `Payment provider "${code}" is not installed`, { available: listPaymentProviders().map((p) => p.code) });
  }
}

export class MethodsAdminService {
  // ---------------------------------------------------------------- entrega
  listShipping() {
    return prisma.shippingMethod.findMany({ include: { rates: { orderBy: [{ country: 'asc' }, { province: 'asc' }, { city: 'asc' }] } }, orderBy: { sortOrder: 'asc' } });
  }

  async createShipping(ctx: AuditContext, input: CreateShipping) {
    if (await prisma.shippingMethod.count({ where: { code: input.code } })) throw Errors.conflict('METHOD_CODE_EXISTS', 'Code already exists');
    return prisma.$transaction(async (tx) => {
      const m = await tx.shippingMethod.create({ data: input });
      await recordAudit(tx, ctx, { action: 'shipping_method.create', resourceType: 'ShippingMethod', resourceId: m.id, after: m });
      return m;
    });
  }

  async updateShipping(ctx: AuditContext, id: string, input: UpdateShipping) {
    const current = await prisma.shippingMethod.findUnique({ where: { id } });
    if (!current) throw Errors.notFound('Shipping method');
    const min = input.estimatedDaysMin ?? current.estimatedDaysMin;
    const max = input.estimatedDaysMax ?? current.estimatedDaysMax;
    if (min > max) throw Errors.badRequest('INVALID_ESTIMATE', 'estimatedDaysMax must be >= estimatedDaysMin');
    if (input.code && input.code !== current.code && (await prisma.shippingMethod.count({ where: { code: input.code } }))) throw Errors.conflict('METHOD_CODE_EXISTS', 'Code already exists');
    return prisma.$transaction(async (tx) => {
      const m = await tx.shippingMethod.update({ where: { id }, data: input });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'shipping_method.update', resourceType: 'ShippingMethod', resourceId: id, ...diff });
      return m;
    });
  }

  async addRate(ctx: AuditContext, methodId: string, input: CreateRate) {
    if (!(await prisma.shippingMethod.count({ where: { id: methodId } }))) throw Errors.notFound('Shipping method');
    return prisma.$transaction(async (tx) => {
      const r = await tx.shippingRate.create({ data: { ...input, methodId } });
      await recordAudit(tx, ctx, { action: 'shipping_rate.create', resourceType: 'ShippingRate', resourceId: r.id, after: r });
      return r;
    });
  }

  async updateRate(ctx: AuditContext, id: string, input: UpdateRate) {
    const current = await prisma.shippingRate.findUnique({ where: { id } });
    if (!current) throw Errors.notFound('Shipping rate');
    return prisma.$transaction(async (tx) => {
      const r = await tx.shippingRate.update({ where: { id }, data: input });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'shipping_rate.update', resourceType: 'ShippingRate', resourceId: id, ...diff });
      return r;
    });
  }

  async deleteRate(ctx: AuditContext, id: string) {
    const current = await prisma.shippingRate.findUnique({ where: { id } });
    if (!current) throw Errors.notFound('Shipping rate');
    await prisma.$transaction(async (tx) => {
      await tx.shippingRate.delete({ where: { id } });
      await recordAudit(tx, ctx, { action: 'shipping_rate.delete', resourceType: 'ShippingRate', resourceId: id, before: current });
    });
  }

  // ---------------------------------------------------------------- pagamento
  async listPayment() {
    const methods = await prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } });
    return { methods, providers: listPaymentProviders() };
  }

  async createPayment(ctx: AuditContext, input: CreatePayment) {
    assertProvider(input.provider);
    if (await prisma.paymentMethod.count({ where: { code: input.code } })) throw Errors.conflict('METHOD_CODE_EXISTS', 'Code already exists');
    return prisma.$transaction(async (tx) => {
      const m = await tx.paymentMethod.create({ data: { ...input, config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined } });
      await recordAudit(tx, ctx, { action: 'payment_method.create', resourceType: 'PaymentMethod', resourceId: m.id, after: m });
      return m;
    });
  }

  async updatePayment(ctx: AuditContext, id: string, input: UpdatePayment) {
    const current = await prisma.paymentMethod.findUnique({ where: { id } });
    if (!current) throw Errors.notFound('Payment method');
    if (input.provider) assertProvider(input.provider);
    if (input.code && input.code !== current.code && (await prisma.paymentMethod.count({ where: { code: input.code } }))) throw Errors.conflict('METHOD_CODE_EXISTS', 'Code already exists');
    const { config, ...rest } = input;
    return prisma.$transaction(async (tx) => {
      const m = await tx.paymentMethod.update({
        where: { id },
        data: { ...rest, ...(config !== undefined ? { config: config === null ? Prisma.DbNull : (config as Prisma.InputJsonValue) } : {}) },
      });
      const diff = diffFields(current as unknown as Record<string, unknown>, input as Record<string, unknown>);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'payment_method.update', resourceType: 'PaymentMethod', resourceId: id, ...diff });
      return m;
    });
  }
}
