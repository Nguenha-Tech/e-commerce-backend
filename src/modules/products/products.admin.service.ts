import type { FastifyRequest } from 'fastify';
import { InventoryMovementType, prisma, Prisma, ProductStatus, RecordStatus, type Db } from '../../db/client';
import { recordAudit, type AuditContext, diffFields } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import { slugify, uniqueSlug } from '../../utils/slug';
import { UploadsService } from '../uploads/uploads.service';
import { refreshProductAggregates } from './aggregates';
import {
  pricingIssues,
  type CreateProductInput,
  type CreateVariantInput,
  type SpecificationInput,
  type UpdateProductInput,
  type UpdateVariantInput,
} from './products.schemas';

const MAX_IMAGES = 20;

const adminDetailInclude = {
  brand: { select: { id: true, name: true, slug: true } },
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }] },
  specifications: { orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }] },
  tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
  variants: {
    where: { deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    include: { inventory: true },
  },
  relatedFrom: { select: { type: true, sortOrder: true, relatedProductId: true } },
} satisfies Prisma.ProductInclude;

/** Campos de auditoria do produto (preços vivem nas variantes e são auditados lá). */
const auditable = (p: Record<string, unknown>) => {
  const { images, variants, specifications, tags, brand, category, relatedFrom, ...rest } = p;
  void images; void variants; void specifications; void tags; void brand; void category; void relatedFrom;
  return rest;
};

function variantData(v: CreateVariantInput | (Omit<CreateVariantInput, 'stock'> & { stock?: CreateVariantInput['stock'] })) {
  const { stock, ...rest } = v;
  void stock;
  return { ...rest, options: rest.options as Prisma.InputJsonValue };
}

async function createVariantWithStock(tx: Db, productId: string, v: CreateVariantInput, actorId?: string) {
  const variant = await tx.productVariant.create({
    data: {
      ...variantData(v),
      productId,
      inventory: {
        create: { quantity: v.stock.quantity, minStock: v.stock.minStock, maxStock: v.stock.maxStock, location: v.stock.location },
      },
    },
    include: { inventory: true },
  });
  if (v.stock.quantity > 0) {
    await tx.inventoryMovement.create({
      data: {
        inventoryId: variant.inventory!.id,
        type: InventoryMovementType.INITIAL,
        quantity: v.stock.quantity,
        quantityBefore: 0,
        quantityAfter: v.stock.quantity,
        reason: 'Stock inicial',
        referenceType: 'PRODUCT_CREATE',
        referenceId: productId,
        createdById: actorId,
      },
    });
  }
  return variant;
}

async function syncTags(tx: Db, productId: string, names: string[]) {
  await tx.productTag.deleteMany({ where: { productId } });
  const unique = [...new Map(names.map((n) => [slugify(n, 80), n.trim()])).entries()].filter(([slug]) => slug);
  for (const [slug, name] of unique) {
    const tag = await tx.tag.upsert({ where: { slug }, update: {}, create: { slug, name } });
    await tx.productTag.create({ data: { productId, tagId: tag.id } });
  }
}

async function syncSpecs(tx: Db, productId: string, specs: SpecificationInput[]) {
  await tx.productSpecification.deleteMany({ where: { productId } });
  if (specs.length === 0) return;
  await tx.productSpecification.createMany({
    data: specs.map((s, i) => ({
      ...s,
      productId,
      sortOrder: s.sortOrder || i,
      // valor numérico permite filtros por intervalo (ex.: bateria >= 5000 mAh)
      numericValue: s.numericValue ?? (Number.isFinite(parseFloat(s.value)) ? parseFloat(s.value) : undefined),
    })),
  });
}

export class ProductsAdminService {
  constructor(private readonly uploads: UploadsService) {}

  private async getRaw(id: string) {
    const product = await prisma.product.findFirst({ where: { id, deletedAt: null }, include: adminDetailInclude });
    if (!product) throw Errors.notFound('Product');
    return product;
  }

  async get(id: string) {
    const p = await this.getRaw(id);
    return {
      ...p,
      tags: p.tags.map((t) => t.tag),
      variants: p.variants.map((v) => ({
        ...v,
        inventory: v.inventory && { ...v.inventory, available: v.inventory.quantity - v.inventory.reserved },
      })),
    };
  }

  async list(q: { page: number; limit: number; search?: string; status?: ProductStatus; category?: string; brand?: string; includeDeleted?: boolean }) {
    const where: Prisma.ProductWhereInput = {
      ...(q.includeDeleted ? {} : { deletedAt: null }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { categoryId: q.category } : {}),
      ...(q.brand ? { brandId: q.brand } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { sku: { contains: q.search, mode: 'insensitive' } },
              { internalCode: { contains: q.search, mode: 'insensitive' } },
              { variants: { some: { sku: { contains: q.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        select: {
          id: true, name: true, slug: true, sku: true, status: true, currency: true, minPrice: true, maxPrice: true,
          availableStock: true, soldCount: true, isFeatured: true, createdAt: true, updatedAt: true, deletedAt: true,
          brand: { select: { name: true } }, category: { select: { name: true } },
          images: { where: { isMain: true }, select: { thumbnailUrl: true }, take: 1 },
          _count: { select: { variants: { where: { deletedAt: null } } } },
        },
        orderBy: { updatedAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  private async assertRefs(categoryId?: string, brandId?: string | null) {
    if (categoryId) {
      const cat = await prisma.category.findFirst({ where: { id: categoryId, deletedAt: null }, select: { id: true } });
      if (!cat) throw Errors.badRequest('CATEGORY_NOT_FOUND', 'Category not found');
    }
    if (brandId) {
      const brand = await prisma.brand.findFirst({ where: { id: brandId, deletedAt: null }, select: { id: true } });
      if (!brand) throw Errors.badRequest('BRAND_NOT_FOUND', 'Brand not found');
    }
  }

  private async assertSkusFree(skus: string[], exceptVariantIds: string[] = []) {
    if (!skus.length) return;
    const taken = await prisma.productVariant.findMany({
      where: { sku: { in: skus }, id: { notIn: exceptVariantIds } },
      select: { sku: true },
    });
    if (taken.length) throw Errors.conflict('SKU_ALREADY_IN_USE', 'SKU already in use', { skus: taken.map((t) => t.sku) });
  }

  async create(ctx: AuditContext, input: CreateProductInput) {
    await this.assertRefs(input.categoryId, input.brandId);
    if (await prisma.product.findUnique({ where: { sku: input.sku }, select: { id: true } })) {
      throw Errors.conflict('SKU_ALREADY_IN_USE', 'Product SKU already in use');
    }

    // Produto simples => uma variante default com o SKU do produto.
    const variants: CreateVariantInput[] =
      input.variants ??
      [
        {
          sku: input.sku,
          options: {},
          ...input.pricing!,
          ...(input.physical ?? {}),
          isDefault: true,
          isActive: true,
          sortOrder: 0,
          stock: input.stock ?? { quantity: 0, minStock: 0 },
        },
      ];
    if (!variants.some((v) => v.isDefault)) variants[0]!.isDefault = true;
    await this.assertSkusFree(variants.map((v) => v.sku));

    const slug = input.slug
      ? await this.assertSlugFree(input.slug)
      : await uniqueSlug(input.name, async (s) => Boolean(await prisma.product.findUnique({ where: { slug: s }, select: { id: true } })));

    const { variants: _v, pricing: _p, stock: _s, physical: _ph, specifications, tags, status, ...fields } = input;
    void _v; void _p; void _s; void _ph;

    const productId = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { ...fields, slug, status: ProductStatus.DRAFT, createdById: ctx.actorId },
      });
      for (const v of variants) await createVariantWithStock(tx, product.id, v, ctx.actorId);
      await syncSpecs(tx, product.id, specifications);
      await syncTags(tx, product.id, tags);
      await refreshProductAggregates(product.id, tx);
      await recordAudit(tx, ctx, {
        action: 'product.create',
        resourceType: 'Product',
        resourceId: product.id,
        after: { name: product.name, sku: product.sku, variants: variants.map((v) => ({ sku: v.sku, price: v.price, stock: v.stock.quantity })) },
      });
      return product.id;
    });

    // Publicar exige imagens: na criação só é possível se o pedido pedir ACTIVE e tudo estiver ok.
    if (status === ProductStatus.ACTIVE) await this.changeStatus(ctx, productId, ProductStatus.ACTIVE);
    return this.get(productId);
  }

  private async assertSlugFree(slug: string, selfId?: string) {
    const normalized = slugify(slug, 220);
    const existing = await prisma.product.findUnique({ where: { slug: normalized }, select: { id: true } });
    if (existing && existing.id !== selfId) throw Errors.conflict('SLUG_ALREADY_IN_USE', 'Slug is already in use');
    return normalized;
  }

  async update(ctx: AuditContext, id: string, input: UpdateProductInput) {
    const current = await this.getRaw(id);
    await this.assertRefs(input.categoryId, input.brandId);
    if (input.slug) input.slug = await this.assertSlugFree(input.slug, id);
    if (input.sku && input.sku !== current.sku) {
      if (await prisma.product.findUnique({ where: { sku: input.sku }, select: { id: true } })) {
        throw Errors.conflict('SKU_ALREADY_IN_USE', 'Product SKU already in use');
      }
    }
    const hasWarranty = input.hasWarranty ?? current.hasWarranty;
    const warrantyMonths = input.warrantyMonths !== undefined ? input.warrantyMonths : current.warrantyMonths;
    if (hasWarranty && !warrantyMonths) throw Errors.badRequest('WARRANTY_MONTHS_REQUIRED', 'warrantyMonths is required when hasWarranty is true');

    const { specifications, tags, ...fields } = input;
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: fields });
      if (specifications) await syncSpecs(tx, id, specifications);
      if (tags) await syncTags(tx, id, tags);
      const diff = diffFields(auditable(current), fields);
      if (diff.changed || specifications || tags) {
        await recordAudit(tx, ctx, {
          action: 'product.update',
          resourceType: 'Product',
          resourceId: id,
          before: { ...diff.before, ...(specifications ? { specifications: current.specifications.length } : {}) },
          after: { ...diff.after, ...(specifications ? { specifications: specifications.length } : {}), ...(tags ? { tags } : {}) },
        });
      }
    });
    if (fields.categoryId || fields.brandId !== undefined) await refreshProductAggregates(id);
    return this.get(id);
  }

  /** Validação para publicar: categoria ativa, ≥1 variante ativa com preço > 0 e ≥1 imagem. */
  private publishIssues(p: Awaited<ReturnType<ProductsAdminService['getRaw']>>, categoryActive: boolean) {
    const issues: string[] = [];
    if (!categoryActive) issues.push('Category must be active');
    if (!p.variants.some((v) => v.isActive && v.price > 0)) issues.push('At least one active variant with a price is required');
    if (p.images.length === 0) issues.push('At least one image is required');
    if (!p.description && !p.shortDescription) issues.push('A description is required');
    return issues;
  }

  async changeStatus(ctx: AuditContext, id: string, status: ProductStatus) {
    const p = await this.getRaw(id);
    if (status === ProductStatus.OUT_OF_STOCK) {
      throw Errors.badRequest('INVALID_STATUS', 'OUT_OF_STOCK is managed automatically from inventory');
    }
    if (status === ProductStatus.ACTIVE) {
      const cat = await prisma.category.findUnique({ where: { id: p.categoryId }, select: { status: true, deletedAt: true } });
      const issues = this.publishIssues(p, cat?.status === RecordStatus.ACTIVE && !cat.deletedAt);
      if (issues.length) throw Errors.unprocessable('PRODUCT_NOT_PUBLISHABLE', 'Product cannot be published yet', { issues });
    }
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: { status, ...(status === ProductStatus.ACTIVE && !p.publishedAt ? { publishedAt: new Date() } : {}) },
      });
      await recordAudit(tx, ctx, { action: 'product.status', resourceType: 'Product', resourceId: id, before: { status: p.status }, after: { status } });
    });
    if (status === ProductStatus.ACTIVE) await refreshProductAggregates(id); // pode passar a OUT_OF_STOCK
    return this.get(id);
  }

  /** Soft delete: sai do catálogo mas os pedidos históricos continuam íntegros (snapshots). */
  async remove(ctx: AuditContext, id: string) {
    const p = await this.getRaw(id);
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: { deletedAt: new Date(), status: ProductStatus.INACTIVE, slug: `${p.slug}--deleted-${Date.now()}`.slice(0, 220) },
      });
      await tx.cartItem.deleteMany({ where: { variant: { productId: id } } });
      await recordAudit(tx, ctx, { action: 'product.delete', resourceType: 'Product', resourceId: id, before: { name: p.name, sku: p.sku, status: p.status } });
    });
  }

  // ------------------------------------------------------------------ variantes
  async addVariant(ctx: AuditContext, productId: string, input: CreateVariantInput) {
    await this.getRaw(productId);
    await this.assertSkusFree([input.sku]);
    await prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.productVariant.updateMany({ where: { productId }, data: { isDefault: false } });
      const v = await createVariantWithStock(tx, productId, input, ctx.actorId);
      await recordAudit(tx, ctx, { action: 'variant.create', resourceType: 'ProductVariant', resourceId: v.id, after: { productId, sku: v.sku, price: v.price, stock: input.stock.quantity } });
    });
    await refreshProductAggregates(productId);
    return this.get(productId);
  }

  async updateVariant(ctx: AuditContext, variantId: string, input: UpdateVariantInput) {
    const v = await prisma.productVariant.findFirst({ where: { id: variantId, deletedAt: null } });
    if (!v) throw Errors.notFound('Variant');
    const merged = { ...v, ...input };
    const issues = pricingIssues(merged);
    if (issues.length) throw Errors.badRequest('INVALID_PRICING', 'Invalid pricing', { issues });
    if (input.sku && input.sku !== v.sku) await this.assertSkusFree([input.sku], [variantId]);
    if (input.isActive === false) await this.assertNotLastActive(v.productId, variantId);

    await prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.productVariant.updateMany({ where: { productId: v.productId, id: { not: variantId } }, data: { isDefault: false } });
      const data = { ...input, ...(input.options ? { options: input.options as Prisma.InputJsonValue } : {}) };
      await tx.productVariant.update({ where: { id: variantId }, data });
      const diff = diffFields(v as unknown as Record<string, unknown>, input as Record<string, unknown>);
      // Ex.: "Preço: anterior 4 500 000 → novo 4 200 000" fica no audit log.
      if (diff.changed) await recordAudit(tx, ctx, { action: 'variant.update', resourceType: 'ProductVariant', resourceId: variantId, ...diff });
    });
    await refreshProductAggregates(v.productId);
    return this.get(v.productId);
  }

  private async assertNotLastActive(productId: string, variantId: string) {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { status: true } });
    const others = await prisma.productVariant.count({ where: { productId, id: { not: variantId }, deletedAt: null, isActive: true } });
    if (others === 0 && product.status !== ProductStatus.DRAFT) {
      throw Errors.conflict('LAST_ACTIVE_VARIANT', 'A published product needs at least one active variant');
    }
  }

  async removeVariant(ctx: AuditContext, variantId: string) {
    const v = await prisma.productVariant.findFirst({ where: { id: variantId, deletedAt: null }, include: { inventory: true } });
    if (!v) throw Errors.notFound('Variant');
    await this.assertNotLastActive(v.productId, variantId);
    if ((v.inventory?.reserved ?? 0) > 0) throw Errors.conflict('VARIANT_HAS_RESERVATIONS', 'Variant has stock reserved by pending orders');
    await prisma.$transaction(async (tx) => {
      // SKU libertado para reutilização; pedidos antigos guardam o SKU no snapshot.
      await tx.productVariant.update({ where: { id: variantId }, data: { deletedAt: new Date(), isActive: false, isDefault: false, sku: `${v.sku}~DEL${Date.now()}`.slice(0, 64) } });
      await tx.cartItem.deleteMany({ where: { variantId } });
      if (v.isDefault) {
        const next = await tx.productVariant.findFirst({ where: { productId: v.productId, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
        if (next) await tx.productVariant.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      await recordAudit(tx, ctx, { action: 'variant.delete', resourceType: 'ProductVariant', resourceId: variantId, before: { sku: v.sku, price: v.price } });
    });
    await refreshProductAggregates(v.productId);
  }

  // ------------------------------------------------------------------ imagens
  async addImages(ctx: AuditContext, productId: string, request: FastifyRequest) {
    const product = await this.getRaw(productId);
    const { files, fields } = await this.uploads.uploadFromRequest(request, 'products');
    try {
      if (product.images.length + files.length > MAX_IMAGES) throw Errors.unprocessable('TOO_MANY_IMAGES', `Max ${MAX_IMAGES} images per product`);
      const variantId = fields.variantId || null;
      if (variantId && !product.variants.some((v) => v.id === variantId)) throw Errors.badRequest('VARIANT_NOT_FOUND', 'Variant does not belong to this product');

      const hasMain = product.images.some((i) => i.isMain);
      const startOrder = product.images.reduce((m, i) => Math.max(m, i.sortOrder + 1), 0);
      await prisma.$transaction(async (tx) => {
        await tx.productImage.createMany({
          data: files.map((f, i) => ({
            productId,
            variantId,
            url: f.url,
            thumbnailUrl: f.thumbnailUrl,
            storageKey: f.storageKey,
            thumbnailKey: f.thumbnailKey,
            storageProvider: f.storageProvider,
            altText: fields.altText || product.name,
            width: f.width,
            height: f.height,
            sizeBytes: f.sizeBytes,
            mimeType: f.mimeType,
            sortOrder: startOrder + i,
            isMain: !hasMain && i === 0,
          })),
        });
        await recordAudit(tx, ctx, { action: 'product.images.add', resourceType: 'Product', resourceId: productId, after: { count: files.length, keys: files.map((f) => f.storageKey) } });
      });
    } catch (err) {
      await this.uploads.removeImages(files);
      throw err;
    }
    return (await this.get(productId)).images;
  }

  async updateImage(ctx: AuditContext, productId: string, imageId: string, input: { altText?: string | null; sortOrder?: number; isMain?: true; variantId?: string | null }) {
    const product = await this.getRaw(productId);
    const image = product.images.find((i) => i.id === imageId);
    if (!image) throw Errors.notFound('Image');
    if (input.variantId && !product.variants.some((v) => v.id === input.variantId)) throw Errors.badRequest('VARIANT_NOT_FOUND', 'Variant does not belong to this product');
    await prisma.$transaction(async (tx) => {
      if (input.isMain) await tx.productImage.updateMany({ where: { productId }, data: { isMain: false } });
      await tx.productImage.update({ where: { id: imageId }, data: input });
      await recordAudit(tx, ctx, { action: 'product.image.update', resourceType: 'ProductImage', resourceId: imageId, ...diffFields(image as unknown as Record<string, unknown>, input) });
    });
    return (await this.get(productId)).images;
  }

  async reorderImages(productId: string, imageIds: string[]) {
    const product = await this.getRaw(productId);
    const known = new Set(product.images.map((i) => i.id));
    if (imageIds.some((id) => !known.has(id))) throw Errors.badRequest('IMAGE_NOT_FOUND', 'Some images do not belong to this product');
    await prisma.$transaction(imageIds.map((id, idx) => prisma.productImage.update({ where: { id }, data: { sortOrder: idx } })));
    return (await this.get(productId)).images;
  }

  async removeImage(ctx: AuditContext, productId: string, imageId: string) {
    const product = await this.getRaw(productId);
    const image = product.images.find((i) => i.id === imageId);
    if (!image) throw Errors.notFound('Image');
    if (product.images.length === 1 && product.status === ProductStatus.ACTIVE) {
      throw Errors.conflict('LAST_IMAGE', 'A published product needs at least one image');
    }
    await prisma.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id: imageId } });
      if (image.isMain) {
        const next = product.images.find((i) => i.id !== imageId);
        if (next) await tx.productImage.update({ where: { id: next.id }, data: { isMain: true } });
      }
      await recordAudit(tx, ctx, { action: 'product.image.delete', resourceType: 'ProductImage', resourceId: imageId, before: { url: image.url } });
    });
    await this.uploads.removeImages([image]); // depois do commit
  }

  // ------------------------------------------------------------------ relacionados
  async setRelations(ctx: AuditContext, productId: string, type: Prisma.ProductRelationCreateManyInput['type'], productIds: string[]) {
    await this.getRaw(productId);
    const ids = [...new Set(productIds)].filter((id) => id !== productId);
    const found = await prisma.product.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== ids.length) throw Errors.badRequest('PRODUCT_NOT_FOUND', 'Some related products do not exist');
    await prisma.$transaction(async (tx) => {
      await tx.productRelation.deleteMany({ where: { productId, type } });
      await tx.productRelation.createMany({ data: ids.map((relatedProductId, sortOrder) => ({ productId, relatedProductId, type, sortOrder })) });
      await recordAudit(tx, ctx, { action: 'product.relations', resourceType: 'Product', resourceId: productId, after: { type, productIds: ids } });
    });
    return { type, productIds: ids };
  }
}
