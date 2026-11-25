import { prisma, ProductStatus, RecordStatus } from '../../db/client';
import { recordAudit, type AuditContext, diffFields } from '../../utils/audit';
import { TtlCache } from '../../utils/cache';
import { Errors } from '../../utils/errors';
import { slugify, uniqueSlug } from '../../utils/slug';
import type { CreateCategoryInput, UpdateCategoryInput } from './categories.schemas';

const MAX_DEPTH = 5;

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  parentId: string | null;
  status: RecordStatus;
  sortOrder: number;
  metaTitle: string | null;
  metaDescription: string | null;
  children: CategoryNode[];
}

type FlatCategory = Omit<CategoryNode, 'children'>;

const select = {
  id: true,
  name: true,
  slug: true,
  description: true,
  imageUrl: true,
  parentId: true,
  status: true,
  sortOrder: true,
  metaTitle: true,
  metaDescription: true,
} as const;

/** Categorias mudam pouco e são lidas em quase todas as páginas: cache curta invalidada em escritas. */
const cache = new TtlCache<FlatCategory[]>(60_000);

async function loadAll(): Promise<FlatCategory[]> {
  return cache.getOrSet('all', () =>
    prisma.category.findMany({ where: { deletedAt: null }, select, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
  );
}

export function invalidateCategoryCache() {
  cache.clear();
}

function buildTree(rows: FlatCategory[], onlyActive: boolean): CategoryNode[] {
  const visible = onlyActive ? rows.filter((r) => r.status === RecordStatus.ACTIVE) : rows;
  const byId = new Map<string, CategoryNode>(visible.map((r) => [r.id, { ...r, children: [] }]));
  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else if (!node.parentId) roots.push(node); // filhos de pais inativos ficam ocultos
  }
  return roots;
}

/** IDs da categoria e de todos os descendentes (para filtrar "Smartphones" incluindo Android/iPhone). */
export async function descendantIds(rootId: string, onlyActive = true): Promise<string[]> {
  const rows = await loadAll();
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (onlyActive && r.status !== RecordStatus.ACTIVE) continue;
    if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.id]);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

export async function findCategoryBySlugOrId(value: string) {
  const rows = await loadAll();
  return rows.find((r) => r.id === value || r.slug === value);
}

export class CategoriesService {
  async tree(onlyActive = true) {
    return buildTree(await loadAll(), onlyActive);
  }

  async getBySlug(slug: string) {
    const rows = await loadAll();
    const cat = rows.find((r) => r.slug === slug && r.status === RecordStatus.ACTIVE);
    if (!cat) throw Errors.notFound('Category');

    const breadcrumb: Array<{ id: string; name: string; slug: string }> = [];
    let current: FlatCategory | undefined = cat;
    while (current) {
      breadcrumb.unshift({ id: current.id, name: current.name, slug: current.slug });
      current = current.parentId ? rows.find((r) => r.id === current!.parentId) : undefined;
    }
    const children = rows.filter((r) => r.parentId === cat.id && r.status === RecordStatus.ACTIVE);
    return { ...cat, breadcrumb, children };
  }

  async adminList() {
    const rows = await prisma.category.findMany({
      where: { deletedAt: null },
      select: { ...select, createdAt: true, updatedAt: true, _count: { select: { products: { where: { deletedAt: null } } } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(({ _count, ...r }) => ({ ...r, productsCount: _count.products }));
  }

  private async assertParent(parentId: string | null | undefined, selfId?: string) {
    if (!parentId) return;
    const rows = await prisma.category.findMany({ where: { deletedAt: null }, select: { id: true, parentId: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (!byId.has(parentId)) throw Errors.badRequest('PARENT_CATEGORY_NOT_FOUND', 'Parent category not found');
    // Sobe a árvore a partir do novo pai: não pode encontrar a própria categoria (ciclo).
    let depth = 1;
    for (let cur = byId.get(parentId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (cur.id === selfId) throw Errors.badRequest('CATEGORY_CYCLE', 'A category cannot be its own ancestor');
      if (++depth > MAX_DEPTH) throw Errors.badRequest('CATEGORY_TOO_DEEP', `Maximum depth is ${MAX_DEPTH}`);
    }
  }

  async create(ctx: AuditContext, input: CreateCategoryInput) {
    await this.assertParent(input.parentId);
    const slug = input.slug
      ? await this.assertSlugFree(input.slug)
      : await uniqueSlug(input.name, async (s) => Boolean(await prisma.category.findUnique({ where: { slug: s }, select: { id: true } })));

    const created = await prisma.$transaction(async (tx) => {
      const cat = await tx.category.create({ data: { ...input, slug, parentId: input.parentId ?? null }, select });
      await recordAudit(tx, ctx, { action: 'category.create', resourceType: 'Category', resourceId: cat.id, after: cat });
      return cat;
    });
    invalidateCategoryCache();
    return created;
  }

  private async assertSlugFree(slug: string, selfId?: string) {
    const normalized = slugify(slug);
    const existing = await prisma.category.findUnique({ where: { slug: normalized }, select: { id: true } });
    if (existing && existing.id !== selfId) throw Errors.conflict('SLUG_ALREADY_IN_USE', 'Slug is already in use');
    return normalized;
  }

  async update(ctx: AuditContext, id: string, input: UpdateCategoryInput) {
    const current = await prisma.category.findFirst({ where: { id, deletedAt: null }, select });
    if (!current) throw Errors.notFound('Category');
    if (input.parentId !== undefined) await this.assertParent(input.parentId, id);
    if (input.slug) input.slug = await this.assertSlugFree(input.slug, id);

    const updated = await prisma.$transaction(async (tx) => {
      const cat = await tx.category.update({ where: { id }, data: input, select });
      const diff = diffFields(current, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'category.update', resourceType: 'Category', resourceId: id, ...diff });
      return cat;
    });
    invalidateCategoryCache();
    return updated;
  }

  /** Soft delete; recusado se tiver subcategorias ou produtos ativos (pedidos antigos mantêm snapshots). */
  async remove(ctx: AuditContext, id: string) {
    const cat = await prisma.category.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: {
          select: {
            children: { where: { deletedAt: null } },
            products: { where: { deletedAt: null, status: { notIn: [ProductStatus.DISCONTINUED, ProductStatus.INACTIVE] } } },
          },
        },
      },
    });
    if (!cat) throw Errors.notFound('Category');
    if (cat._count.children > 0) throw Errors.conflict('CATEGORY_HAS_CHILDREN', 'Move or delete the subcategories first');
    if (cat._count.products > 0) throw Errors.conflict('CATEGORY_HAS_PRODUCTS', 'Category still has active products');

    await prisma.$transaction(async (tx) => {
      await tx.category.update({
        where: { id },
        // liberta o slug para reutilização
        data: { deletedAt: new Date(), status: RecordStatus.INACTIVE, slug: `${cat.slug}--deleted-${Date.now()}` },
      });
      await recordAudit(tx, ctx, { action: 'category.delete', resourceType: 'Category', resourceId: id, before: { name: cat.name, slug: cat.slug } });
    });
    invalidateCategoryCache();
  }
}
