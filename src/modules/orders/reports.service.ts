import { z } from 'zod';
import { env } from '../../config/env';
import { prisma, Prisma } from '../../db/client';
import { paginationQuery } from '../../utils/pagination';

/*
 * Dashboard e relatórios — agregações em SQL (nunca carregar pedidos para memória).
 * "Venda" = pedido confirmado (pago ou pagamento na entrega aceite): exclui PENDING e CANCELLED.
 * Datas agrupadas no fuso da loja (STORE_TIMEZONE). Valores em centavos.
 */

const SALE = Prisma.raw(`('CONFIRMED','PROCESSING','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','RETURN_REQUESTED','RETURNED','REFUNDED')`);
const TZ = env.STORE_TIMEZONE;
/** Converte timestamp UTC (sem fuso) para a hora local da loja. */
const local = (col: string) => Prisma.sql`(${Prisma.raw(col)} AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})`;

export const PERIODS = ['day', 'week', 'month', 'year'] as const;
export type Period = (typeof PERIODS)[number];

const DEFAULT_SPAN_DAYS: Record<Period, number> = { day: 30, week: 7 * 12, month: 365, year: 365 * 5 };

function withRange<T extends { period: Period; from?: Date; to?: Date }>(q: T, ctx: z.RefinementCtx) {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - DEFAULT_SPAN_DAYS[q.period] * 86_400_000);
  if (from >= to) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must be before to' });
    return z.NEVER;
  }
  if (to.getTime() - from.getTime() > 3660 * 86_400_000) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'Range too large (max 10 years)' });
    return z.NEVER;
  }
  return { ...q, from, to };
}

const rangeFields = {
  period: z.enum(PERIODS).default('day'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/** ?period=day|week|month|year&from=2026-01-01&to=2026-12-31 (omissão: janela adequada ao período). */
export const reportRangeQuery = z.object(rangeFields).transform(withRange);

export const rankedReportQuery = paginationQuery
  .extend({ ...rangeFields, sort: z.enum(['units', 'revenue']).default('revenue') })
  .transform(withRange);

export type Range = { period: Period; from: Date; to: Date };

const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Converte linhas com bigint em números (JSON-safe). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
function numify(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));
}

const bucket = (period: Period, col = 'o."placedAt"') => Prisma.sql`date_trunc(${Prisma.raw(`'${period}'`)}, ${local(col)})`;

export class ReportsService {
  // ===================================================================== dashboard
  async dashboard(financial: boolean) {
    const [sales, ops, units, lowStock, customers, topProducts, topCategories] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          COUNT(*) FILTER (WHERE o."status" IN ${SALE})::bigint AS "ordersTotal",
          COALESCE(SUM(o."grandTotal") FILTER (WHERE o."status" IN ${SALE}), 0)::bigint AS "salesTotal",
          COUNT(*) FILTER (WHERE o."status" IN ${SALE} AND ${local('o."placedAt"')}::date = (now() AT TIME ZONE ${TZ})::date)::bigint AS "ordersToday",
          COALESCE(SUM(o."grandTotal") FILTER (WHERE o."status" IN ${SALE} AND ${local('o."placedAt"')}::date = (now() AT TIME ZONE ${TZ})::date), 0)::bigint AS "salesToday",
          COUNT(*) FILTER (WHERE o."status" IN ${SALE} AND date_trunc('month', ${local('o."placedAt"')}) = date_trunc('month', now() AT TIME ZONE ${TZ}))::bigint AS "ordersMonth",
          COALESCE(SUM(o."grandTotal") FILTER (WHERE o."status" IN ${SALE} AND date_trunc('month', ${local('o."placedAt"')}) = date_trunc('month', now() AT TIME ZONE ${TZ})), 0)::bigint AS "salesMonth",
          COALESCE(SUM(o."productDiscount" + o."couponDiscount") FILTER (WHERE o."status" IN ${SALE} AND date_trunc('month', ${local('o."placedAt"')}) = date_trunc('month', now() AT TIME ZONE ${TZ})), 0)::bigint AS "discountsMonth"
        FROM "orders" o`,
      prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS "pending",
          COUNT(*) FILTER (WHERE "status" IN ('CONFIRMED','PROCESSING','PACKED'))::bigint AS "toFulfill",
          COUNT(*) FILTER (WHERE "status" IN ('SHIPPED','OUT_FOR_DELIVERY'))::bigint AS "shipped",
          COUNT(*) FILTER (WHERE "status" = 'DELIVERED' AND date_trunc('month', ${local('"deliveredAt"')}) = date_trunc('month', now() AT TIME ZONE ${TZ}))::bigint AS "deliveredMonth",
          COUNT(*) FILTER (WHERE "status" = 'RETURN_REQUESTED')::bigint AS "returnRequested",
          COUNT(*) FILTER (WHERE "requiresAttention")::bigint AS "requiresAttention"
        FROM "orders"`,
      prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          COALESCE(SUM(oi."quantity"), 0)::bigint AS "unitsTotal",
          COALESCE(SUM(oi."quantity") FILTER (WHERE date_trunc('month', ${local('o."placedAt"')}) = date_trunc('month', now() AT TIME ZONE ${TZ})), 0)::bigint AS "unitsMonth"
        FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId" WHERE o."status" IN ${SALE}`,
      prisma.$queryRaw<Array<{ variantId: string; productId: string; name: string; sku: string; available: number; minStock: number }>>`
        SELECT v."id" AS "variantId", p."id" AS "productId", p."name", v."sku", (i."quantity" - i."reserved")::int AS "available", i."minStock"
        FROM "inventory" i JOIN "product_variants" v ON v."id" = i."variantId" JOIN "products" p ON p."id" = v."productId"
        WHERE v."deletedAt" IS NULL AND v."isActive" AND p."deletedAt" IS NULL AND p."status" IN ('ACTIVE','OUT_OF_STOCK')
          AND i."quantity" - i."reserved" <= i."minStock"
        ORDER BY (i."quantity" - i."reserved") ASC, p."name" LIMIT 10`,
      prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT COUNT(*)::bigint AS "total",
               COUNT(*) FILTER (WHERE date_trunc('month', ${local('u."createdAt"')}) = date_trunc('month', now() AT TIME ZONE ${TZ}))::bigint AS "newThisMonth"
        FROM "users" u
        WHERE u."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."roleId" WHERE ur."userId" = u."id" AND r."name" = 'CUSTOMER')`,
      this.topProducts(this.monthRange(), 5, 'units'),
      this.topCategories(this.monthRange(), 5),
    ]);

    const lowStockCount = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "inventory" i JOIN "product_variants" v ON v."id" = i."variantId" JOIN "products" p ON p."id" = v."productId"
      WHERE v."deletedAt" IS NULL AND v."isActive" AND p."deletedAt" IS NULL AND p."status" IN ('ACTIVE','OUT_OF_STOCK') AND i."quantity" - i."reserved" <= i."minStock"`;

    const s = numify(sales)[0]!;
    const result: Record<string, unknown> = {
      currency: env.DEFAULT_CURRENCY,
      timezone: TZ,
      sales: { total: s.salesTotal, today: s.salesToday, month: s.salesMonth, discountsMonth: s.discountsMonth },
      orders: { total: s.ordersTotal, today: s.ordersToday, month: s.ordersMonth, ...numify(ops)[0] },
      productsSold: numify(units)[0],
      lowStock: { count: n(lowStockCount[0]?.c), items: lowStock },
      customers: numify(customers)[0],
      topProducts,
      topCategories,
    };
    if (financial) result.financial = await this.financialSummary(this.monthRange());
    return result;
  }

  private monthRange() {
    const now = new Date();
    return { from: new Date(now.getTime() - 31 * 86_400_000), to: now };
  }

  /** Só para quem tem reports:financial (OWNER/MANAGER): custo, lucro, margens, reembolsos. */
  async financialSummary(range: { from: Date; to: Date }) {
    const [rev] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          COALESCE(SUM(o."grandTotal"), 0)::bigint AS "grossRevenue",
          COALESCE(SUM(o."taxTotal"), 0)::bigint AS "tax",
          COALESCE(SUM(o."shippingTotal"), 0)::bigint AS "shipping",
          COALESCE(SUM(o."productDiscount" + o."couponDiscount"), 0)::bigint AS "discounts"
        FROM "orders" o WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}`,
    );
    const [cost] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          COALESCE(SUM(oi."costPrice" * oi."quantity"), 0)::bigint AS "costOfGoods",
          COALESCE(SUM(oi."lineTotal") FILTER (WHERE oi."costPrice" IS NOT NULL), 0)::bigint AS "revenueWithCost",
          COALESCE(SUM(oi."lineTotal") FILTER (WHERE oi."costPrice" IS NULL), 0)::bigint AS "revenueWithoutCost"
        FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}`,
    );
    const [refunds] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          COALESCE(SUM("amount") FILTER (WHERE "status" = 'COMPLETED' AND "updatedAt" BETWEEN ${range.from} AND ${range.to}), 0)::bigint AS "refunded",
          COALESCE(SUM("amount") FILTER (WHERE "status" IN ('PENDING','PROCESSING')), 0)::bigint AS "pendingRefunds"
        FROM "refunds"`,
    );
    const r = rev!;
    const c = cost!;
    const netRevenue = r.grossRevenue - refunds!.refunded;
    // Lucro bruto só sobre itens com custo conhecido (evita margens inflacionadas).
    const grossProfit = c.revenueWithCost - c.costOfGoods;
    return {
      range,
      ...r,
      refunded: refunds!.refunded,
      pendingRefunds: refunds!.pendingRefunds,
      netRevenue,
      costOfGoods: c.costOfGoods,
      grossProfit,
      grossMarginPercent: c.revenueWithCost > 0 ? Math.round((grossProfit / c.revenueWithCost) * 1000) / 10 : null,
      revenueWithoutCostData: c.revenueWithoutCost,
    };
  }

  // ===================================================================== relatórios
  /** Vendas ao longo do tempo. */
  async sales(range: Range) {
    const [orders, units] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT ${bucket(range.period)} AS "bucket",
               COUNT(*)::bigint AS "orders",
               COALESCE(SUM(o."subtotal"), 0)::bigint AS "subtotal",
               COALESCE(SUM(o."productDiscount" + o."couponDiscount"), 0)::bigint AS "discounts",
               COALESCE(SUM(o."shippingTotal"), 0)::bigint AS "shipping",
               COALESCE(SUM(o."taxTotal"), 0)::bigint AS "tax",
               COALESCE(SUM(o."grandTotal"), 0)::bigint AS "total",
               COALESCE(ROUND(AVG(o."grandTotal")), 0)::bigint AS "averageOrderValue"
        FROM "orders" o
        WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<Array<{ bucket: Date; units: bigint }>>`
        SELECT ${bucket(range.period)} AS "bucket", COALESCE(SUM(oi."quantity"), 0)::bigint AS "units"
        FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
        WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        GROUP BY 1`,
    ]);
    const unitsBy = new Map(units.map((u) => [new Date(u.bucket).getTime(), Number(u.units)]));
    const series: Row[] = numify(orders).map((r) => ({ ...r, units: unitsBy.get(new Date(r.bucket).getTime()) ?? 0 }));
    const totals = series.reduce(
      (acc, r) => {
        for (const k of ['orders', 'subtotal', 'discounts', 'shipping', 'tax', 'total', 'units'] as const) acc[k] += Number(r[k] ?? 0);
        return acc;
      },
      { orders: 0, subtotal: 0, discounts: 0, shipping: 0, tax: 0, total: 0, units: 0 },
    );
    return { range, totals: { ...totals, averageOrderValue: totals.orders ? Math.round(totals.total / totals.orders) : 0 }, series };
  }

  async topProducts(range: { from: Date; to: Date }, limit = 20, sort: 'units' | 'revenue' = 'revenue', offset = 0, financial = false) {
    const order = sort === 'units' ? Prisma.sql`"units" DESC` : Prisma.sql`"revenue" DESC`;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT oi."productId", MAX(oi."productName") AS "name", MAX(oi."productSlug") AS "slug",
             SUM(oi."quantity")::bigint AS "units", SUM(oi."lineTotal")::bigint AS "revenue",
             COUNT(DISTINCT oi."orderId")::bigint AS "orders",
             SUM((oi."originalUnitPrice" - oi."unitPrice") * oi."quantity" + oi."couponDiscount")::bigint AS "discounts"
             ${financial ? Prisma.sql`, SUM(oi."costPrice" * oi."quantity")::bigint AS "cost", (SUM(oi."lineTotal") FILTER (WHERE oi."costPrice" IS NOT NULL) - SUM(oi."costPrice" * oi."quantity"))::bigint AS "grossProfit"` : Prisma.empty}
      FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
      WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY oi."productId" ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
    return numify(rows as Array<Record<string, bigint>>);
  }

  async topCategories(range: { from: Date; to: Date }, limit = 10) {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT c."id" AS "categoryId", c."name", c."slug", SUM(oi."quantity")::bigint AS "units", SUM(oi."lineTotal")::bigint AS "revenue"
      FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId" JOIN "categories" c ON c."id" = oi."categoryId"
      WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
      GROUP BY c."id", c."name", c."slug" ORDER BY "revenue" DESC LIMIT ${limit}`;
    return numify(rows as Array<Record<string, bigint>>);
  }

  async products(range: Range, q: { page: number; limit: number; sort: 'units' | 'revenue' }, financial: boolean) {
    const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(DISTINCT oi."productId")::bigint AS total FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
      WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}`;
    const items = await this.topProducts(range, q.limit, q.sort, (q.page - 1) * q.limit, financial);
    const categories = await this.topCategories(range, 20);
    return { range, items, categories, meta: { page: q.page, limit: q.limit, total: n(total), totalPages: Math.max(1, Math.ceil(n(total) / q.limit)) } };
  }

  /** Stock atual (+ valorização a custo se financeiro) e movimentos no período. */
  async stock(range: Range, financial: boolean) {
    const [summary] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT COUNT(*)::bigint AS "variants",
               COALESCE(SUM(i."quantity"), 0)::bigint AS "units",
               COALESCE(SUM(i."reserved"), 0)::bigint AS "reserved",
               COUNT(*) FILTER (WHERE i."quantity" - i."reserved" <= 0)::bigint AS "outOfStock",
               COUNT(*) FILTER (WHERE i."quantity" - i."reserved" > 0 AND i."quantity" - i."reserved" <= i."minStock")::bigint AS "lowStock",
               COUNT(*) FILTER (WHERE i."maxStock" IS NOT NULL AND i."quantity" > i."maxStock")::bigint AS "overStock",
               COALESCE(SUM(i."quantity" * v."price"), 0)::bigint AS "retailValue"
               ${financial ? Prisma.sql`, COALESCE(SUM(i."quantity" * v."costPrice"), 0)::bigint AS "costValue"` : Prisma.empty}
        FROM "inventory" i JOIN "product_variants" v ON v."id" = i."variantId" JOIN "products" p ON p."id" = v."productId"
        WHERE v."deletedAt" IS NULL AND p."deletedAt" IS NULL`,
    );
    const movements = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT m."type", COUNT(*)::bigint AS "movements", SUM(m."quantity")::bigint AS "units"
        FROM "inventory_movements" m WHERE m."createdAt" BETWEEN ${range.from} AND ${range.to}
        GROUP BY m."type" ORDER BY m."type"`,
    );
    return { range, summary, movements };
  }

  async customers(range: Range) {
    const series = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT ${bucket(range.period, 'u."createdAt"')} AS "bucket", COUNT(*)::bigint AS "newCustomers"
        FROM "users" u
        WHERE u."deletedAt" IS NULL AND u."createdAt" BETWEEN ${range.from} AND ${range.to}
          AND EXISTS (SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."roleId" WHERE ur."userId" = u."id" AND r."name" = 'CUSTOMER')
        GROUP BY 1 ORDER BY 1`,
    );
    const top = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT u."id" AS "userId", u."name", u."email", COUNT(o."id")::bigint AS "orders", SUM(o."grandTotal")::bigint AS "spent", MAX(o."placedAt") AS "lastOrderAt"
        FROM "orders" o JOIN "users" u ON u."id" = o."userId"
        WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}
        GROUP BY u."id", u."name", u."email" ORDER BY "spent" DESC LIMIT 20`,
    );
    const [buyers] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT COUNT(DISTINCT o."userId")::bigint AS "buyers",
               COUNT(DISTINCT o."userId") FILTER (WHERE (SELECT COUNT(*) FROM "orders" o2 WHERE o2."userId" = o."userId" AND o2."status" IN ${SALE}) > 1)::bigint AS "returningBuyers"
        FROM "orders" o WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to}`,
    );
    return { range, ...buyers, newCustomers: series, topCustomers: top };
  }

  async orders(range: Range) {
    const byStatus = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT "status", COUNT(*)::bigint AS "orders", COALESCE(SUM("grandTotal"), 0)::bigint AS "amount"
        FROM "orders" WHERE "placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY "status" ORDER BY "status"`,
    );
    const byPaymentStatus = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT "paymentStatus", COUNT(*)::bigint AS "orders" FROM "orders" WHERE "placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 1`,
    );
    const byShipping = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT "shippingMethodCode" AS "method", COUNT(*)::bigint AS "orders" FROM "orders" WHERE "placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 2 DESC`,
    );
    const series = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT ${bucket(range.period)} AS "bucket", COUNT(*)::bigint AS "placed",
               COUNT(*) FILTER (WHERE o."status" = 'CANCELLED')::bigint AS "cancelled",
               COUNT(*) FILTER (WHERE o."status" IN ${SALE})::bigint AS "confirmed"
        FROM "orders" o WHERE o."placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 1`,
    );
    const placed = byStatus.reduce((s, r) => s + (r.orders as number), 0);
    const cancelled = (byStatus.find((r) => r.status === 'CANCELLED')?.orders as number | undefined) ?? 0;
    return { range, placed, cancellationRatePercent: placed ? Math.round((cancelled / placed) * 1000) / 10 : 0, byStatus, byPaymentStatus, byShipping, series };
  }

  /** Receita bruta, reembolsos, líquida, custo e lucro por período (financeiro). */
  async revenue(range: Range) {
    const series = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        WITH sales AS (
          SELECT ${bucket(range.period)} AS b, SUM(o."grandTotal")::bigint AS gross, SUM(o."taxTotal")::bigint AS tax, SUM(o."shippingTotal")::bigint AS shipping
          FROM "orders" o WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1
        ), costs AS (
          SELECT ${bucket(range.period)} AS b, SUM(oi."costPrice" * oi."quantity")::bigint AS cost
          FROM "order_items" oi JOIN "orders" o ON o."id" = oi."orderId"
          WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1
        ), refunds AS (
          SELECT date_trunc(${Prisma.raw(`'${range.period}'`)}, ${local('r."updatedAt"')}) AS b, SUM(r."amount")::bigint AS refunded
          FROM "refunds" r WHERE r."status" = 'COMPLETED' AND r."updatedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1
        )
        SELECT COALESCE(s.b, c.b, rf.b) AS "bucket",
               COALESCE(s.gross, 0)::bigint AS "gross", COALESCE(rf.refunded, 0)::bigint AS "refunded",
               (COALESCE(s.gross, 0) - COALESCE(rf.refunded, 0))::bigint AS "net",
               COALESCE(s.tax, 0)::bigint AS "tax", COALESCE(s.shipping, 0)::bigint AS "shipping",
               COALESCE(c.cost, 0)::bigint AS "costOfGoods"
        FROM sales s FULL OUTER JOIN costs c ON c.b = s.b FULL OUTER JOIN refunds rf ON rf.b = COALESCE(s.b, c.b)
        ORDER BY 1`,
    );
    return { range, summary: await this.financialSummary(range), series };
  }

  async discounts(range: Range) {
    const coupons = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT c."code", COUNT(cu."id")::bigint AS "uses", COALESCE(SUM(cu."discountAmount"), 0)::bigint AS "discount",
               COALESCE(SUM(o."grandTotal"), 0)::bigint AS "ordersTotal"
        FROM "coupon_usages" cu JOIN "coupons" c ON c."id" = cu."couponId" JOIN "orders" o ON o."id" = cu."orderId"
        WHERE o."status" IN ${SALE} AND cu."createdAt" BETWEEN ${range.from} AND ${range.to}
        GROUP BY c."code" ORDER BY "discount" DESC`,
    );
    const series = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT ${bucket(range.period)} AS "bucket", SUM(o."productDiscount")::bigint AS "productDiscount", SUM(o."couponDiscount")::bigint AS "couponDiscount",
               COUNT(*) FILTER (WHERE o."couponId" IS NOT NULL)::bigint AS "ordersWithCoupon", COUNT(*)::bigint AS "orders"
        FROM "orders" o WHERE o."status" IN ${SALE} AND o."placedAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 1`,
    );
    const totals = series.reduce(
      (a, r) => ({ productDiscount: a.productDiscount + (r.productDiscount as number), couponDiscount: a.couponDiscount + (r.couponDiscount as number) }),
      { productDiscount: 0, couponDiscount: 0 },
    );
    return { range, totals: { ...totals, total: totals.productDiscount + totals.couponDiscount }, coupons, series };
  }

  async payments(range: Range) {
    const byMethod = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT p."methodCode", p."provider", p."status", COUNT(*)::bigint AS "payments", COALESCE(SUM(p."amount"), 0)::bigint AS "amount",
               COALESCE(SUM(p."refundedAmount"), 0)::bigint AS "refunded"
        FROM "payments" p WHERE p."createdAt" BETWEEN ${range.from} AND ${range.to}
        GROUP BY 1, 2, 3 ORDER BY 1, 3`,
    );
    const series = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT ${bucket(range.period, 'p."paidAt"')} AS "bucket", COUNT(*)::bigint AS "payments", SUM(p."amount")::bigint AS "collected"
        FROM "payments" p WHERE p."paidAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 1`,
    );
    const [rates] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT COUNT(*) FILTER (WHERE "status" IN ('PAID','REFUNDED','PARTIALLY_REFUNDED'))::bigint AS "succeeded",
               COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed", COUNT(*)::bigint AS "total"
        FROM "payments" WHERE "createdAt" BETWEEN ${range.from} AND ${range.to}`,
    );
    return { range, ...rates, successRatePercent: rates!.total ? Math.round(((rates!.succeeded as number) / (rates!.total as number)) * 1000) / 10 : 0, byMethod, series };
  }

  async returns(range: Range) {
    const byStatus = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT "status", COUNT(*)::bigint AS "returns" FROM "return_requests" WHERE "createdAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 1`,
    );
    const byReason = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT "reason", COUNT(*)::bigint AS "returns" FROM "return_requests" WHERE "createdAt" BETWEEN ${range.from} AND ${range.to} GROUP BY 1 ORDER BY 2 DESC`,
    );
    const topProducts = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT oi."productId", MAX(oi."productName") AS "name", SUM(ri."quantity")::bigint AS "units"
        FROM "return_items" ri JOIN "return_requests" rr ON rr."id" = ri."returnRequestId" JOIN "order_items" oi ON oi."id" = ri."orderItemId"
        WHERE rr."createdAt" BETWEEN ${range.from} AND ${range.to} AND rr."status" NOT IN ('REJECTED','CANCELLED')
        GROUP BY oi."productId" ORDER BY "units" DESC LIMIT 10`,
    );
    const [refunds] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT COUNT(*)::bigint AS "refunds", COALESCE(SUM("amount"), 0)::bigint AS "refunded"
        FROM "refunds" WHERE "returnRequestId" IS NOT NULL AND "status" = 'COMPLETED' AND "updatedAt" BETWEEN ${range.from} AND ${range.to}`,
    );
    const [rate] = numify(
      await prisma.$queryRaw<Array<Record<string, bigint>>>`
        SELECT (SELECT COUNT(*) FROM "return_requests" WHERE "createdAt" BETWEEN ${range.from} AND ${range.to} AND "status" NOT IN ('REJECTED','CANCELLED'))::bigint AS "returns",
               (SELECT COUNT(*) FROM "orders" WHERE "deliveredAt" BETWEEN ${range.from} AND ${range.to})::bigint AS "delivered"`,
    );
    return {
      range,
      returnRatePercent: rate!.delivered ? Math.round(((rate!.returns as number) / (rate!.delivered as number)) * 1000) / 10 : 0,
      byStatus,
      byReason,
      topProducts,
      refunds,
    };
  }
}
