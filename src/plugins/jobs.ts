import fp from 'fastify-plugin';
import { env } from '../config/env';
import { OrdersService } from '../modules/orders/orders.service';
import { PromotionsService } from '../modules/products/promotions.service';

/**
 * Tarefas periódicas leves. Seguras com várias instâncias (cada pedido é processado com
 * SELECT … FOR UPDATE e re-verificação de estado). Para volume alto, mover para uma fila
 * (BullMQ/pg-boss) mantendo a mesma função.
 */
export default fp(
  async (app) => {
    if (!env.JOBS_ENABLED || env.isTest) return;
    const orders = new OrdersService();
    const promotions = new PromotionsService();
    let running = false;
    let lastPromoSync = new Date();

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const expired = await orders.expireStaleOrders();
        if (expired) app.log.info({ expired }, 'expired unpaid orders and released stock');
      } catch (err) {
        app.log.error({ err }, 'reservation sweeper failed');
      }
      try {
        // Promoções que começaram/terminaram: atualiza preços mostrados no catálogo.
        const now = new Date();
        const refreshed = await promotions.syncWindows(lastPromoSync, now);
        lastPromoSync = now;
        if (refreshed) app.log.info({ refreshed }, 'promotion window changed — product prices refreshed');
      } catch (err) {
        app.log.error({ err }, 'promotion sync failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(tick, 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'jobs' },
);
