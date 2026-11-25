import { prisma, Prisma, type ProductStatus } from '../../db/client';
import { Errors } from '../../utils/errors';
import { cardSelect, PUBLIC_STATUSES, toCard } from '../products/products.service';
import type { AddWishlistItemInput } from './account.schemas';

const itemInclude = {
  product: { select: { ...cardSelect, deletedAt: true } },
} satisfies Prisma.WishlistItemInclude;

type ItemRow = Prisma.WishlistItemGetPayload<{ include: typeof itemInclude }>;

/** Wishlist / favoritos — um por cliente, com disponibilidade sempre calculada no servidor. */
export class WishlistService {
  private async ensureWishlist(userId: string) {
    return prisma.wishlist.upsert({ where: { userId }, update: {}, create: { userId }, select: { id: true } });
  }

  private present(item: ItemRow, alerts: Set<string>) {
    const p = item.product;
    const available = !p.deletedAt && (PUBLIC_STATUSES as ProductStatus[]).includes(p.status);
    return {
      id: item.id,
      addedAt: item.createdAt,
      variantId: item.variantId,
      /** O produto foi descontinuado/removido — continua visível para o cliente o poder retirar. */
      available,
      inStock: available && p.availableStock > 0,
      stockAlertActive: item.variantId ? alerts.has(item.variantId) : false,
      product: toCard(p),
    };
  }

  async list(userId: string) {
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId },
      include: { items: { include: itemInclude, orderBy: { createdAt: 'desc' }, take: 200 } },
    });
    const alerts = new Set((await prisma.stockAlert.findMany({ where: { userId, notifiedAt: null }, select: { variantId: true } })).map((a) => a.variantId));
    return (wishlist?.items ?? []).map((i) => this.present(i, alerts));
  }

  async productIds(userId: string): Promise<string[]> {
    const rows = await prisma.wishlistItem.findMany({ where: { wishlist: { userId } }, select: { productId: true } });
    return rows.map((r) => r.productId);
  }

  async add(userId: string, input: AddWishlistItemInput) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, deletedAt: null, status: { in: PUBLIC_STATUSES } },
      select: { id: true, variants: { where: { deletedAt: null, isActive: true }, select: { id: true, isDefault: true }, orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }] } },
    });
    if (!product) throw Errors.notFound('Product');
    if (input.variantId && !product.variants.some((v) => v.id === input.variantId)) {
      throw Errors.unprocessable('VARIANT_NOT_IN_PRODUCT', 'Variant does not belong to this product');
    }
    const variantId = input.variantId ?? (product.variants.length === 1 ? product.variants[0]!.id : null);

    const { id: wishlistId } = await this.ensureWishlist(userId);
    // Idempotente: repetir apenas atualiza a variante preferida.
    await prisma.wishlistItem.upsert({
      where: { wishlistId_productId: { wishlistId, productId: product.id } },
      update: { variantId },
      create: { wishlistId, productId: product.id, variantId },
    });
    if (input.notifyWhenAvailable) {
      if (!variantId) throw Errors.badRequest('VARIANT_REQUIRED', 'Choose a variant to be notified when it is back in stock');
      await this.subscribeStockAlert(userId, variantId);
    }
    return this.list(userId);
  }

  async remove(userId: string, productId: string) {
    const res = await prisma.wishlistItem.deleteMany({ where: { productId, wishlist: { userId } } });
    if (res.count === 0) throw Errors.notFound('Wishlist item');
  }

  async clear(userId: string) {
    await prisma.wishlistItem.deleteMany({ where: { wishlist: { userId } } });
  }

  // ------------------------------------------------------------ alertas de stock
  async listStockAlerts(userId: string) {
    const alerts = await prisma.stockAlert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        variantId: true,
        notifiedAt: true,
        createdAt: true,
        variant: { select: { sku: true, name: true, product: { select: { id: true, name: true, slug: true, availableStock: true } } } },
      },
    });
    return alerts.map((a) => ({ ...a, active: a.notifiedAt === null }));
  }

  /** Subscrever "avise-me quando voltar ao stock". Reativa um alerta já disparado. */
  async subscribeStockAlert(userId: string, variantId: string) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, deletedAt: null, product: { deletedAt: null, status: { in: PUBLIC_STATUSES } } },
      select: { id: true, inventory: { select: { quantity: true, reserved: true } } },
    });
    if (!variant) throw Errors.notFound('Variant');
    const available = (variant.inventory?.quantity ?? 0) - (variant.inventory?.reserved ?? 0);
    if (available > 0) throw Errors.unprocessable('VARIANT_IN_STOCK', 'This item is already in stock');

    return prisma.stockAlert.upsert({
      where: { userId_variantId: { userId, variantId } },
      update: { notifiedAt: null },
      create: { userId, variantId },
      select: { variantId: true, createdAt: true, notifiedAt: true },
    });
  }

  async unsubscribeStockAlert(userId: string, variantId: string) {
    await prisma.stockAlert.deleteMany({ where: { userId, variantId } });
  }

  /** Admin: favoritos de um cliente (gestão de clientes, secção 33). */
  async adminList(userId: string) {
    const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) throw Errors.notFound('User');
    return this.list(userId);
  }
}
