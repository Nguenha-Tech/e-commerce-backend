import { timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../config/env';
import { OrdersService } from '../modules/orders/orders.service';
import { PromotionsService } from '../modules/products/promotions.service';

/**
 * Tarefas periódicas leves. Seguras com várias instâncias (cada pedido é processado com
 * SELECT … FOR UPDATE e re-verificação de estado). Para volume alto, mover para uma fila
 * (BullMQ/pg-boss) mantendo a mesma função.
 *
 * - Servidor normal: corre a cada minuto com setInterval.
 * - Serverless (Vercel): não há processo longo; o Vercel Cron chama
 *   GET /api/v1/internal/cron (protegido por CRON_SECRET).
 */
function createJobRunner(log: FastifyBaseLogger) {
  const orders = new OrdersService();
  const promotions = new PromotionsService();
  let running = false;
  // Em serverless a primeira sincronização olha 24h para trás, para apanhar mudanças entre execuções do cron.
  let lastPromoSync = new Date(Date.now() - (env.isServerless ? 24 * 60 * 60_000 : 0));

  return async function runJobs() {
    if (running) return { skipped: true };
    running = true;
    const result: { expired?: number; refreshed?: number; errors: string[] } = { errors: [] };
    try {
      try {
        const expired = await orders.expireStaleOrders();
        result.expired = expired;
        if (expired) log.info({ expired }, 'expired unpaid orders and released stock');
      } catch (err) {
        result.errors.push('reservation sweeper failed');
        log.error({ err }, 'reservation sweeper failed');
      }
      try {
        // Promoções que começaram/terminaram: atualiza preços mostrados no catálogo.
        const now = new Date();
        const refreshed = await promotions.syncWindows(lastPromoSync, now);
        lastPromoSync = now;
        result.refreshed = refreshed;
        if (refreshed) log.info({ refreshed }, 'promotion window changed — product prices refreshed');
      } catch (err) {
        result.errors.push('promotion sync failed');
        log.error({ err }, 'promotion sync failed');
      }
    } finally {
      running = false;
    }
    return result;
  };
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export default fp(
  async (app) => {
    if (env.isTest) return;
    const runJobs = createJobRunner(app.log);

    if (env.isServerless) {
      // Sem CRON_SECRET a rota não existe (nunca expor uma rota de jobs sem proteção).
      if (!env.CRON_SECRET) {
        app.log.warn('CRON_SECRET not set — scheduled jobs (order expiry, promotion sync) will not run');
        return;
      }
      const expected = `Bearer ${env.CRON_SECRET}`;
      app.get('/api/v1/internal/cron', { schema: { hide: true }, config: { rateLimit: false } }, async (req, reply) => {
        if (!safeEqual(req.headers.authorization ?? '', expected)) return reply.code(401).send({ error: 'unauthorized' });
        return runJobs();
      });
      return;
    }

    if (!env.JOBS_ENABLED) return;
    const timer = setInterval(() => void runJobs(), 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'jobs' },
);
