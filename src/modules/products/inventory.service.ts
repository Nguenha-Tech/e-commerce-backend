import { InventoryMovementType, NotificationType, prisma, Prisma, type Db } from '../../db/client';
import { recordAudit, type AuditContext, diffFields } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { notify } from '../../utils/notifications';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import { refreshProductAggregates } from './aggregates';

/*
 * Inventário — invariantes: 0 <= reserved <= quantity ; disponível = quantity - reserved.
 * Todas as mudanças são UPDATEs condicionais atómicos (sem ler-depois-escrever), por isso
 * dois checkouts simultâneos sobre a última unidade nunca vendem a mesma unidade.
 * A BD tem CHECK constraints como última linha de defesa.
 */

export interface StockLine {
  variantId: string;
  quantity: number;
  sku?: string;
}

type Row = { id: string; quantity: number; reserved: number };

const OUTFLOW = new Set<InventoryMovementType>([InventoryMovementType.ADJUSTMENT_OUT, InventoryMovementType.DAMAGED, InventoryMovementType.SALE]);

async function insufficient(db: Db, line: StockLine): Promise<never> {
  const inv = await db.inventory.findUnique({ where: { variantId: line.variantId }, select: { quantity: true, reserved: true } });
  const available = inv ? Math.max(0, inv.quantity - inv.reserved) : 0;
  throw Errors.conflict('INSUFFICIENT_STOCK', `Insufficient stock${line.sku ? ` for ${line.sku}` : ''}`, {
    variantId: line.variantId,
    sku: line.sku,
    requested: line.quantity,
    available,
  });
}

/** Ordena por variantId para que transações concorrentes bloqueiem linhas na mesma ordem (sem deadlocks). */
const ordered = (lines: StockLine[]) => [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));

/** Reserva temporária (checkout). Lança INSUFFICIENT_STOCK e a transação inteira é revertida. */
export async function reserveStock(tx: Db, lines: StockLine[]): Promise<void> {
  for (const line of ordered(lines)) {
    const n = await tx.$executeRaw`
      UPDATE "inventory" SET "reserved" = "reserved" + ${line.quantity}, "updatedAt" = now()
      WHERE "variantId" = ${line.variantId}::uuid AND "quantity" - "reserved" >= ${line.quantity}`;
    if (n === 0) await insufficient(tx, line);
  }
}

/** Liberta reserva (pagamento falhou/expirou, pedido cancelado antes de pagar). */
export async function releaseReservedStock(tx: Db, line: StockLine): Promise<void> {
  await tx.$executeRaw`
    UPDATE "inventory" SET "reserved" = GREATEST("reserved" - ${line.quantity}, 0), "updatedAt" = now()
    WHERE "variantId" = ${line.variantId}::uuid`;
}

interface MovementMeta {
  type: InventoryMovementType;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  actorId?: string;
}

async function logMovement(tx: Db, row: Row, delta: number, meta: MovementMeta) {
  await tx.inventoryMovement.create({
    data: {
      inventoryId: row.id,
      type: meta.type,
      quantity: delta,
      quantityBefore: row.quantity - delta,
      quantityAfter: row.quantity,
      reason: meta.reason,
      referenceType: meta.referenceType,
      referenceId: meta.referenceId,
      createdById: meta.actorId,
    },
  });
}

/**
 * Saída definitiva por venda. Se `fromReservation`, converte a reserva em saída;
 * senão (reserva expirada / pagamento na entrega sem reserva) exige stock disponível.
 * Devolve false quando não há stock (o chamador decide: ex. pedido requer atenção).
 */
export async function commitSale(tx: Db, line: StockLine, fromReservation: boolean, meta: Omit<MovementMeta, 'type'>): Promise<boolean> {
  const rows = fromReservation
    ? await tx.$queryRaw<Row[]>`
        UPDATE "inventory" SET "quantity" = "quantity" - ${line.quantity}, "reserved" = "reserved" - ${line.quantity}, "updatedAt" = now()
        WHERE "variantId" = ${line.variantId}::uuid AND "reserved" >= ${line.quantity} AND "quantity" >= ${line.quantity}
        RETURNING "id", "quantity", "reserved"`
    : await tx.$queryRaw<Row[]>`
        UPDATE "inventory" SET "quantity" = "quantity" - ${line.quantity}, "updatedAt" = now()
        WHERE "variantId" = ${line.variantId}::uuid AND "quantity" - "reserved" >= ${line.quantity}
        RETURNING "id", "quantity", "reserved"`;
  if (rows.length === 0) return false;
  await logMovement(tx, rows[0]!, -line.quantity, { ...meta, type: InventoryMovementType.SALE });
  return true;
}

/** Entrada de stock (cancelamento após venda, devolução recebida…). */
export async function restock(tx: Db, line: StockLine, meta: MovementMeta): Promise<void> {
  const rows = await tx.$queryRaw<Row[]>`
    UPDATE "inventory" SET "quantity" = "quantity" + ${line.quantity}, "updatedAt" = now()
    WHERE "variantId" = ${line.variantId}::uuid
    RETURNING "id", "quantity", "reserved"`;
  if (rows[0]) await logMovement(tx, rows[0], line.quantity, meta);
}

/** Avisa quem pediu "avise-me quando voltar ao stock". */
export async function notifyBackInStock(variantId: string): Promise<void> {
  const alerts = await prisma.stockAlert.findMany({
    where: { variantId, notifiedAt: null },
    select: { id: true, userId: true, variant: { select: { product: { select: { name: true, slug: true } } } } },
    take: 500,
  });
  for (const a of alerts) {
    await notify({
      userId: a.userId,
      type: NotificationType.BACK_IN_STOCK,
      title: 'Produto de volta ao stock',
      body: `${a.variant.product.name} voltou a estar disponível.`,
      data: { variantId, slug: a.variant.product.slug },
    });
  }
  if (alerts.length) await prisma.stockAlert.updateMany({ where: { id: { in: alerts.map((a) => a.id) } }, data: { notifiedAt: new Date() } });
}

// ===================================================================== admin
export class InventoryService {
  async list(params: { page: number; limit: number; search?: string; lowStock?: boolean }) {
    const search = params.search ? `%${params.search}%` : null;
    const low = params.lowStock ? Prisma.sql`AND i."quantity" - i."reserved" <= i."minStock"` : Prisma.empty;
    const term = search ? Prisma.sql`AND (p."name" ILIKE ${search} OR v."sku" ILIKE ${search})` : Prisma.empty;
    const { skip, take } = toSkipTake(params);

    const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM "inventory" i
      JOIN "product_variants" v ON v."id" = i."variantId" JOIN "products" p ON p."id" = v."productId"
      WHERE v."deletedAt" IS NULL AND p."deletedAt" IS NULL ${low} ${term}`;
    const items = await prisma.$queryRaw<
      Array<{ variantId: string; productId: string; productName: string; sku: string; variantName: string | null; quantity: number; reserved: number; available: number; minStock: number; maxStock: number | null; location: string | null; lowStock: boolean }>
    >`
      SELECT v."id" AS "variantId", p."id" AS "productId", p."name" AS "productName", v."sku", v."name" AS "variantName",
             i."quantity", i."reserved", (i."quantity" - i."reserved")::int AS "available", i."minStock", i."maxStock", i."location",
             (i."quantity" - i."reserved" <= i."minStock") AS "lowStock"
      FROM "inventory" i
      JOIN "product_variants" v ON v."id" = i."variantId" JOIN "products" p ON p."id" = v."productId"
      WHERE v."deletedAt" IS NULL AND p."deletedAt" IS NULL ${low} ${term}
      ORDER BY (i."quantity" - i."reserved") ASC, p."name" ASC
      LIMIT ${take} OFFSET ${skip}`;
    return { items, meta: pageMeta(Number(total), params) };
  }

  async movements(variantId: string, params: { page: number; limit: number }) {
    const inv = await prisma.inventory.findUnique({ where: { variantId }, select: { id: true } });
    if (!inv) throw Errors.notFound('Inventory');
    const where = { inventoryId: inv.id };
    const [total, items] = await prisma.$transaction([
      prisma.inventoryMovement.count({ where }),
      prisma.inventoryMovement.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(params) }),
    ]);
    return { items, meta: pageMeta(total, params) };
  }

  async updateSettings(ctx: AuditContext, variantId: string, input: { minStock?: number; maxStock?: number | null; location?: string | null }) {
    const inv = await prisma.inventory.findUnique({ where: { variantId } });
    if (!inv) throw Errors.notFound('Inventory');
    return prisma.$transaction(async (tx) => {
      const updated = await tx.inventory.update({ where: { variantId }, data: input });
      const diff = diffFields(inv, input);
      if (diff.changed) await recordAudit(tx, ctx, { action: 'inventory.settings', resourceType: 'Inventory', resourceId: variantId, ...diff });
      return updated;
    });
  }

  /** Movimento manual: compra ao fornecedor, ajuste, danificado, devolução. Auditado. */
  async createMovement(ctx: AuditContext, variantId: string, input: { type: InventoryMovementType; quantity: number; reason: string }) {
    const variant = await prisma.productVariant.findFirst({ where: { id: variantId, deletedAt: null }, select: { productId: true, sku: true } });
    if (!variant) throw Errors.notFound('Variant');
    const outflow = OUTFLOW.has(input.type);
    const delta = outflow ? -input.quantity : input.quantity;

    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.inventory.findUnique({ where: { variantId }, select: { quantity: true, reserved: true } });
      if (!before) throw Errors.notFound('Inventory');
      // Saídas nunca podem consumir unidades reservadas por pedidos em curso.
      const rows = outflow
        ? await tx.$queryRaw<Row[]>`
            UPDATE "inventory" SET "quantity" = "quantity" - ${input.quantity}, "updatedAt" = now()
            WHERE "variantId" = ${variantId}::uuid AND "quantity" - "reserved" >= ${input.quantity}
            RETURNING "id", "quantity", "reserved"`
        : await tx.$queryRaw<Row[]>`
            UPDATE "inventory" SET "quantity" = "quantity" + ${input.quantity}, "updatedAt" = now()
            WHERE "variantId" = ${variantId}::uuid
            RETURNING "id", "quantity", "reserved"`;
      if (rows.length === 0) {
        throw Errors.conflict('INSUFFICIENT_STOCK', 'Cannot remove more than the available (unreserved) stock', {
          available: before.quantity - before.reserved,
        });
      }
      const row = rows[0]!;
      await logMovement(tx, row, delta, { type: input.type, reason: input.reason, referenceType: 'MANUAL', actorId: ctx.actorId });
      await recordAudit(tx, ctx, {
        action: 'inventory.movement',
        resourceType: 'Inventory',
        resourceId: variantId,
        before: { quantity: before.quantity },
        after: { quantity: row.quantity, type: input.type, delta, reason: input.reason, sku: variant.sku },
      });
      return { wasOut: before.quantity - before.reserved <= 0, row };
    });

    await refreshProductAggregates(variant.productId);
    if (result.wasOut && result.row.quantity - result.row.reserved > 0) await notifyBackInStock(variantId);
    return { variantId, quantity: result.row.quantity, reserved: result.row.reserved, available: result.row.quantity - result.row.reserved };
  }
}
