import { z } from 'zod';
import { env } from '../../config/env';
import { InventoryMovementType, ProductRelationType, ProductStatus, RecordStatus } from '../../db/client';
import { paginationQuery } from '../../utils/pagination';

// ----------------------------------------------------------------- comuns
export const idParams = z.object({ id: z.string().uuid() });
export const slugParams = z.object({ slug: z.string().trim().min(1).max(220) });
export const productImageParams = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });
export const variantIdParams = z.object({ variantId: z.string().uuid() });

/** Montante em centavos (inteiro, ≥ 0, até 100 milhões de unidades). */
export const money = z.number().int('Amounts are integers in minor units (cents)').min(0).max(10_000_000_000);
const dimension = z.number().int().min(0).max(10_000_000);
export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{1,63}$/, 'SKU: 2-64 chars, letters, numbers, ".", "_" or "-"');
const slugField = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug').max(220);
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
const csv = (max = 20) =>
  z
    .string()
    .max(500)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, max));
/** Aceita `?spec=a&spec=b` ou `?spec=a`. */
const repeated = z.union([z.string().max(200), z.array(z.string().max(200)).max(20)]).transform((v) => (Array.isArray(v) ? v : [v]));

// ----------------------------------------------------------------- listagem pública
export const PRODUCT_SORTS = ['relevance', 'newest', 'best_selling', 'price_asc', 'price_desc', 'rating', 'popular', 'discount'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const listProductsQuery = paginationQuery.extend({
  search: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().max(140).optional(), // slug ou id (inclui subcategorias)
  brand: csv().optional(), // slugs separados por vírgula
  tags: csv().optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  inStock: queryBool.optional(),
  onSale: queryBool.optional(),
  featured: queryBool.optional(),
  isNew: queryBool.optional(),
  color: csv().optional(),
  /** Opções de variante: option=storage:256GB */
  option: repeated.optional(),
  /** Especificações: spec=RAM:8GB&spec=5G:Sim */
  spec: repeated.optional(),
  sort: z.enum(PRODUCT_SORTS).optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuery>;

export const relatedQuery = z.object({
  type: z.enum(['SIMILAR', 'RECOMMENDED', 'ACCESSORY', 'FREQUENTLY_BOUGHT_TOGETHER', 'ALSO_BOUGHT']).default('SIMILAR'),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

// ----------------------------------------------------------------- admin: variantes
const stockInput = z
  .object({
    quantity: z.number().int().min(0).max(1_000_000).default(0),
    minStock: z.number().int().min(0).max(1_000_000).default(0),
    maxStock: z.number().int().min(0).max(1_000_000).optional(),
    location: z.string().trim().max(80).optional(),
  })
  .default({});

const pricingFields = {
  originalPrice: money,
  price: money,
  promoPrice: money.nullable().optional(),
  promoStartsAt: z.coerce.date().nullable().optional(),
  promoEndsAt: z.coerce.date().nullable().optional(),
  costPrice: money.nullable().optional(),
};

const physicalFields = {
  weightGrams: dimension.nullable().optional(),
  heightMm: dimension.nullable().optional(),
  widthMm: dimension.nullable().optional(),
  lengthMm: dimension.nullable().optional(),
  packageWeightGrams: dimension.nullable().optional(),
  packageHeightMm: dimension.nullable().optional(),
  packageWidthMm: dimension.nullable().optional(),
  packageLengthMm: dimension.nullable().optional(),
};

type PricingLike = { originalPrice?: number; price?: number; promoPrice?: number | null; promoStartsAt?: Date | null; promoEndsAt?: Date | null };

/** Regras de coerência de preços reutilizadas em create e update. */
export function pricingIssues(p: PricingLike): string[] {
  const issues: string[] = [];
  if (p.price !== undefined && p.originalPrice !== undefined && p.price > p.originalPrice) issues.push('price must be <= originalPrice');
  if (p.promoPrice != null && p.price !== undefined && p.promoPrice >= p.price) issues.push('promoPrice must be lower than price');
  if (p.promoStartsAt && p.promoEndsAt && p.promoStartsAt >= p.promoEndsAt) issues.push('promoEndsAt must be after promoStartsAt');
  return issues;
}

const withPricingRules = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((v: PricingLike, ctx) => {
    for (const message of pricingIssues(v)) ctx.addIssue({ code: 'custom', message });
  });

/** Ex.: { color: "Preto", storage: "256GB" } */
export const variantOptions = z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(60)).refine((o) => Object.keys(o).length <= 5, 'Max 5 options');

const variantBase = z.object({
  sku: skuSchema,
  name: z.string().trim().max(120).optional(),
  options: variantOptions.default({}),
  barcode: z.string().trim().max(64).optional(),
  ...pricingFields,
  ...physicalFields,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const createVariantBody = withPricingRules(variantBase.extend({ stock: stockInput }));
/** Coerência final de preços é validada no serviço, juntando com os valores atuais. */
export const updateVariantBody = withPricingRules(variantBase.partial().strict());

// ----------------------------------------------------------------- admin: especificações / produto
export const specificationInput = z.object({
  group: z.string().trim().max(60).optional(),
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(300),
  unit: z.string().trim().max(20).optional(),
  numericValue: z.number().finite().optional(),
  isFilterable: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

const productBase = {
  name: z.string().trim().min(2).max(200),
  slug: slugField.optional(),
  internalCode: z.string().trim().max(64).optional(),
  shortDescription: z.string().trim().max(500).optional(),
  description: z.string().trim().max(50_000).optional(),
  brandId: z.string().uuid().nullable().optional(),
  categoryId: z.string().uuid(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  isFeatured: z.boolean().default(false),
  isNew: z.boolean().default(false),
  isRecommended: z.boolean().default(false),
  currency: z.string().length(3).toUpperCase().default(env.DEFAULT_CURRENCY),
  hasWarranty: z.boolean().default(false),
  warrantyMonths: z.number().int().min(1).max(120).optional(),
  warrantyTerms: z.string().trim().max(5000).optional(),
  metaTitle: z.string().trim().max(70).optional(),
  metaDescription: z.string().trim().max(170).optional(),
  canonicalUrl: z.string().url().max(500).optional(),
};

export const createProductBody = z
  .object({
    ...productBase,
    sku: skuSchema,
    status: z.enum([ProductStatus.DRAFT, ProductStatus.ACTIVE]).default(ProductStatus.DRAFT),
    /** Produto simples (sem variantes): preço, stock e físico ao nível do produto. */
    pricing: withPricingRules(z.object(pricingFields)).optional(),
    stock: stockInput.optional(),
    physical: z.object(physicalFields).optional(),
    /** Produto com variantes (cor/armazenamento…): cada uma com SKU, preço e stock. */
    variants: z.array(createVariantBody).min(1).max(100).optional(),
    specifications: z.array(specificationInput).max(150).default([]),
  })
  .superRefine((v, ctx) => {
    if (!v.variants && !v.pricing) ctx.addIssue({ code: 'custom', path: ['pricing'], message: 'Provide pricing (simple product) or variants' });
    if (v.variants && v.pricing) ctx.addIssue({ code: 'custom', path: ['pricing'], message: 'Use either pricing or variants, not both' });
    if (v.hasWarranty && !v.warrantyMonths) ctx.addIssue({ code: 'custom', path: ['warrantyMonths'], message: 'Required when hasWarranty is true' });
    if (v.variants) {
      const skus = v.variants.map((x) => x.sku);
      if (new Set(skus).size !== skus.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Variant SKUs must be unique' });
      const combos = v.variants.map((x) => JSON.stringify(Object.entries(x.options).sort()));
      if (new Set(combos).size !== combos.length) ctx.addIssue({ code: 'custom', path: ['variants'], message: 'Two variants have the same options' });
    }
  });

export const updateProductBody = z
  .object({
    ...productBase,
    sku: skuSchema,
    slug: slugField,
    brandId: z.string().uuid().nullable(),
    internalCode: z.string().trim().max(64).nullable(),
    shortDescription: z.string().trim().max(500).nullable(),
    description: z.string().trim().max(50_000).nullable(),
    warrantyMonths: z.number().int().min(1).max(120).nullable(),
    warrantyTerms: z.string().trim().max(5000).nullable(),
    metaTitle: z.string().trim().max(70).nullable(),
    metaDescription: z.string().trim().max(170).nullable(),
    canonicalUrl: z.string().url().max(500).nullable(),
    specifications: z.array(specificationInput).max(150),
  })
  .partial()
  .strict()
  .transform((v) => {
    // Em PATCH os defaults do productBase não podem aplicar-se a campos não enviados.
    return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as typeof v;
  });

export const changeStatusBody = z.object({ status: z.nativeEnum(ProductStatus) });

export const adminListProductsQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  status: z.nativeEnum(ProductStatus).optional(),
  category: z.string().uuid().optional(),
  brand: z.string().uuid().optional(),
  includeDeleted: queryBool.optional(),
});

export const updateImageBody = z
  .object({
    altText: z.string().trim().max(200).nullable(),
    sortOrder: z.number().int().min(0).max(1000),
    isMain: z.literal(true),
    variantId: z.string().uuid().nullable(),
  })
  .partial()
  .strict();

export const reorderImagesBody = z.object({ imageIds: z.array(z.string().uuid()).min(1).max(50) });

export const setRelationsBody = z.object({
  type: z.nativeEnum(ProductRelationType),
  productIds: z.array(z.string().uuid()).max(30),
});

// ----------------------------------------------------------------- marcas
export const createBrandBody = z.object({
  name: z.string().trim().min(1).max(80),
  slug: slugField.optional(),
  logoUrl: z.string().url().max(500).optional(),
  description: z.string().trim().max(2000).optional(),
  website: z.string().url().max(300).optional(),
  status: z.nativeEnum(RecordStatus).default(RecordStatus.ACTIVE),
});

export const updateBrandBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: slugField,
    logoUrl: z.string().url().max(500).nullable(),
    description: z.string().trim().max(2000).nullable(),
    website: z.string().url().max(300).nullable(),
    status: z.nativeEnum(RecordStatus),
  })
  .partial()
  .strict();

// ----------------------------------------------------------------- inventário
export const MANUAL_MOVEMENTS = [
  InventoryMovementType.PURCHASE,
  InventoryMovementType.ADJUSTMENT_IN,
  InventoryMovementType.ADJUSTMENT_OUT,
  InventoryMovementType.DAMAGED,
  InventoryMovementType.RETURN,
] as const;

export const createMovementBody = z.object({
  type: z.enum(MANUAL_MOVEMENTS),
  quantity: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().min(3).max(300),
});

export const inventorySettingsBody = z
  .object({
    minStock: z.number().int().min(0).max(1_000_000),
    maxStock: z.number().int().min(0).max(1_000_000).nullable(),
    location: z.string().trim().max(80).nullable(),
  })
  .partial()
  .strict();

export const listInventoryQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  lowStock: queryBool.optional(),
});

export type CreateProductInput = z.infer<typeof createProductBody>;
export type UpdateProductInput = z.infer<typeof updateProductBody>;
export type CreateVariantInput = z.infer<typeof createVariantBody>;
export type UpdateVariantInput = z.infer<typeof updateVariantBody>;
export type SpecificationInput = z.infer<typeof specificationInput>;
