import { prisma, Prisma, WhatsAppSource } from '../../../../db/client';
import { sha256 } from '../../../../utils/crypto';

/**
 * WhatsAppAnalytics — guarda apenas metadados do clique (origem, produto, data).
 * Nunca o conteúdo das conversas. O visitante é um hash diário não reversível (IP+UA+dia),
 * suficiente para contar visitantes únicos sem guardar o IP.
 */

/** Nome do evento para relatórios (secção 71). */
export const EVENT_NAMES: Record<WhatsAppSource, string> = {
  HOMEPAGE: 'WHATSAPP_BUTTON_CLICKED',
  CONTACT: 'WHATSAPP_BUTTON_CLICKED',
  PRODUCT: 'PRODUCT_WHATSAPP_CLICKED',
  CART: 'CART_WHATSAPP_CLICKED',
  CHECKOUT: 'SUPPORT_WHATSAPP_CLICKED',
  SUPPORT: 'SUPPORT_WHATSAPP_CLICKED',
};

export function visitorHash(ip: string, userAgent: string | undefined, now = new Date()): string {
  return sha256(`${ip}|${userAgent ?? ''}|${now.toISOString().slice(0, 10)}`);
}

export async function recordClick(input: { source: WhatsAppSource; productId?: string; variantId?: string; userId?: string; visitorHash: string }) {
  try {
    await prisma.whatsAppClickEvent.create({ data: input });
  } catch {
    // Analytics nunca bloqueia o cliente.
  }
}

export async function clickStats(from: Date, to: Date) {
  const range = { createdAt: { gte: from, lte: to } };
  const [total, bySource, unique, topProducts, daily] = await Promise.all([
    prisma.whatsAppClickEvent.count({ where: range }),
    prisma.whatsAppClickEvent.groupBy({ by: ['source'], where: range, _count: { _all: true } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT "visitorHash")::bigint AS n FROM "whatsapp_click_events" WHERE "createdAt" BETWEEN ${from} AND ${to}`,
    prisma.$queryRaw<{ productId: string; name: string; slug: string; clicks: bigint }[]>`
      SELECT e."productId", p."name", p."slug", COUNT(*)::bigint AS clicks
      FROM "whatsapp_click_events" e JOIN "products" p ON p."id" = e."productId"
      WHERE e."createdAt" BETWEEN ${from} AND ${to} AND e."productId" IS NOT NULL
      GROUP BY e."productId", p."name", p."slug" ORDER BY clicks DESC LIMIT 10`,
    prisma.$queryRaw<{ day: Date; clicks: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS clicks
      FROM "whatsapp_click_events" WHERE "createdAt" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 1`),
  ]);
  return {
    range: { from, to },
    totalClicks: total,
    uniqueVisitors: Number(unique[0]?.n ?? 0),
    bySource: bySource.map((s) => ({ source: s.source, event: EVENT_NAMES[s.source], clicks: s._count._all })),
    topProducts: topProducts.map((p) => ({ ...p, clicks: Number(p.clicks) })),
    daily: daily.map((d) => ({ day: d.day, clicks: Number(d.clicks) })),
  };
}
