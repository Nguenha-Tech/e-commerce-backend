import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { PERMISSIONS } from '../../config/permissions';
import { ok } from '../../utils/response';
import {
  addWishlistItemBody,
  auditQuery,
  idParams,
  listNotificationsQuery,
  productIdParams,
  stockAlertBody,
  variantIdParams,
} from './account.schemas';
import { AuditService } from './audit.service';
import { NotificationsService } from './notifications.service';
import { WishlistService } from './wishlist.service';

const wishlist = new WishlistService();
const notifications = new NotificationsService();
const audit = new AuditService();

/** /api/v1/wishlist — favoritos e alertas "voltou ao stock". */
export const wishlistRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Wishlist'];
  app.addHook('preHandler', app.authenticate);

  app.get('/', { schema: { tags, summary: 'Listar favoritos (com disponibilidade)' } }, async (request) => ok(await wishlist.list(request.auth!.userId)));

  app.get('/ids', { schema: { tags, summary: 'IDs dos produtos favoritos (para marcar corações no catálogo)' } }, async (request) =>
    ok(await wishlist.productIds(request.auth!.userId)),
  );

  app.post('/items', { schema: { tags, summary: 'Adicionar aos favoritos (idempotente)', body: addWishlistItemBody } }, async (request, reply) =>
    reply.code(201).send(ok(await wishlist.add(request.auth!.userId, request.body), 'Added to wishlist')),
  );

  app.delete('/items/:productId', { schema: { tags, summary: 'Remover dos favoritos', params: productIdParams } }, async (request) => {
    await wishlist.remove(request.auth!.userId, request.params.productId);
    return ok(null, 'Removed from wishlist');
  });

  app.delete('/', { schema: { tags, summary: 'Esvaziar favoritos' } }, async (request) => {
    await wishlist.clear(request.auth!.userId);
    return ok(null, 'Wishlist cleared');
  });

  app.get('/stock-alerts', { schema: { tags, summary: 'Alertas de reposição de stock' } }, async (request) => ok(await wishlist.listStockAlerts(request.auth!.userId)));

  app.post('/stock-alerts', { schema: { tags, summary: 'Avisar-me quando voltar ao stock', body: stockAlertBody } }, async (request, reply) =>
    reply.code(201).send(ok(await wishlist.subscribeStockAlert(request.auth!.userId, request.body.variantId), 'Stock alert created')),
  );

  app.delete('/stock-alerts/:variantId', { schema: { tags, summary: 'Cancelar alerta de stock', params: variantIdParams } }, async (request) => {
    await wishlist.unsubscribeStockAlert(request.auth!.userId, request.params.variantId);
    return ok(null, 'Stock alert removed');
  });
};

/** /api/v1/notifications — notificações internas do utilizador. */
export const notificationsRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Notifications'];
  app.addHook('preHandler', app.authenticate);

  app.get('/', { schema: { tags, summary: 'Listar notificações (meta.unread = total por ler)', querystring: listNotificationsQuery } }, async (request) => {
    const { items, meta } = await notifications.list(request.auth!.userId, request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/unread-count', { schema: { tags, summary: 'Número de notificações por ler' } }, async (request) => ok(await notifications.unreadCount(request.auth!.userId)));

  app.post('/:id/read', { schema: { tags, summary: 'Marcar como lida', params: idParams } }, async (request) => {
    await notifications.markRead(request.auth!.userId, request.params.id);
    return ok(null, 'Notification marked as read');
  });

  app.post('/read-all', { schema: { tags, summary: 'Marcar todas como lidas' } }, async (request) =>
    ok(await notifications.markAllRead(request.auth!.userId), 'All notifications marked as read'),
  );

  app.delete('/:id', { schema: { tags, summary: 'Apagar notificação', params: idParams } }, async (request) => {
    await notifications.remove(request.auth!.userId, request.params.id);
    return ok(null, 'Notification deleted');
  });
};

/** /api/v1/admin — auditoria e favoritos de clientes. */
export const accountAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const P = PERMISSIONS;
  app.addHook('preHandler', app.authenticate);

  app.get('/customers/:id/wishlist', { preHandler: app.authorize(P.CUSTOMERS_READ), schema: { tags: ['Admin · Users & Roles'], summary: 'Favoritos de um cliente', params: idParams } }, async (request) =>
    ok(await wishlist.adminList(request.params.id)),
  );

  const tags = ['Admin · Audit'];
  app.get('/audit-logs', { preHandler: app.authorize(P.AUDIT_READ), schema: { tags, summary: 'Consultar auditoria (filtros: ator, ação, recurso, datas)', querystring: auditQuery } }, async (request) => {
    const { items, meta } = await audit.list(request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/audit-logs/actions', { preHandler: app.authorize(P.AUDIT_READ), schema: { tags, summary: 'Ações registadas (para filtros)' } }, async () => ok(await audit.actions()));

  app.get('/audit-logs/:id', { preHandler: app.authorize(P.AUDIT_READ), schema: { tags, summary: 'Detalhe (estado anterior / novo)', params: idParams } }, async (request) =>
    ok(await audit.get(request.params.id)),
  );
};
