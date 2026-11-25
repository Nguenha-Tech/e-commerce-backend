import { prisma, ProductStatus, RecordStatus } from '../../db/client';
import { recordAudit, type AuditContext, diffFields } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/slug';
import { PUBLIC_STATUSES } from './products.service';

interface BrandInput {
  name?: string;
  slug?: string;
  logoUrl?: string | null;
  description?: string | null;
  website?: string | null;
  status?: RecordStatus;
}

const select = { id: true, name: true, slug: true, logoUrl: true, description: true, website: true, status: true } as const;

export class BrandsService {
  async listPublic() {
    const brands = await prisma.brand.findMany({
      where: { deletedAt: null, status: RecordStatus.ACTIVE },
      select: { ...select, _count: { select: { products: { where: { deletedAt: null, status: { in: PUBLIC_STATUSES } } } } } },
      orderBy: { name: 'asc' },
    });
    return brands.map(({ _count, ...b }) => ({ ...b, productsCount: _count.products }));
  }

  async getBySlug(slug: string) {
    const brand = await prisma.brand.findFirst({ where: { slug, deletedAt: null, status: RecordStatus.ACTIVE }, select });
    if (!brand) throw Errors.notFound('Brand');
    return brand;
  }

  async adminList() {
    const brands = await prisma.brand.findMany({
      where: { deletedAt: null },
      select: { ...select, createdAt: true, updatedAt: true, _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: { name: 'asc' },
    });
    return brands.map(({ _count, ...b }) => ({ ...b, productsCount: _count.products }));
  }

  private async assertUnique(input: BrandInput, selfId?: string) {
    if (input.name) {
      const sameName = await prisma.brand.findFirst({ where: { name: { equals: input.name, mode: 'insensitive' }, id: selfId ? { not: selfId } : undefined } });
      if (sameName) throw Errors.conflict('BRAND_ALREADY_EXISTS', 'A brand with this name already exists');
    }
    if (input.slug) {
      input.slug = slugify(input.slug, 100);
      const sameSlug = await prisma.brand.findUnique({ where: { slug: input.slug } });
      if (sameSlug && sameSlug.id !== selfId) throw Errors.conflict('SLUG_ALREADY_IN_USE', 'Slug is already in use');
    }
  }

  async create(ctx: AuditContext, input: BrandInput & { name: string }) {
    await this.assertUnique(input);
    const slug = input.slug ?? (await uniqueSlug(input.name, async (s) => Boolean(await prisma.brand.findUnique({ where: { slug: s } }))));
    return prisma.$transaction(async (tx) => {
      const brand = await tx.brand.create({ data: { ...input, slug }, select });
      await recordAudit(tx, ctx, { action: 'brand.create', resourceType: 'Brand', resourceId: brand.id, after: brand });
      return brand;
    });
  }

  async update(ctx: AuditContext, id: string, input: BrandInput) {
    const current = await prisma.brand.findFirst({ where: { id, deletedAt: null }, select });
    if (!current) throw Errors.notFound('Brand');
    await this.assertUnique(input, id);
    return prisma.$transaction(async (tx) => {
      const brand = await tx.brand.update({ where: { id }, data: input, select });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'brand.update', resourceType: 'Brand', resourceId: id, ...diff });
      return brand;
    });
  }

  async remove(ctx: AuditContext, id: string) {
    const brand = await prisma.brand.findFirst({ where: { id, deletedAt: null } });
    if (!brand) throw Errors.notFound('Brand');
    const active = await prisma.product.count({ where: { brandId: id, deletedAt: null, status: { notIn: [ProductStatus.INACTIVE, ProductStatus.DISCONTINUED] } } });
    if (active > 0) throw Errors.conflict('BRAND_HAS_PRODUCTS', 'Brand still has active products');
    await prisma.$transaction(async (tx) => {
      await tx.brand.update({
        where: { id },
        data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, name: `${brand.name}~del${Date.now()}`.slice(0, 80), slug: `${brand.slug}--deleted-${Date.now()}` },
      });
      await recordAudit(tx, ctx, { action: 'brand.delete', resourceType: 'Brand', resourceId: id, before: { name: brand.name } });
    });
  }
}
