import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { auditContext } from '../../utils/audit';
import { ok } from '../../utils/response';
import {
  adminPromotionsQuery,
  createPromotionBody,
  listPromotionsQuery,
  promotionProductsQuery,
  PromotionsService,
  updatePromotionBody,
} from './promotions.service';

const service = new PromotionsService();
const idParams = z.object({ id: z.string().uuid() });
const slugParams = z.object({ slug: z.string().trim().min(1).max(140) });

/** /api/v1/promotions — promoções ativas (Flash Sale, Black Friday…). */
export const promotionsRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Promotions'];
  app.get('/', { schema: { tags, summary: 'Promoções ativas', querystring: listPromotionsQuery } }, async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=30');
    return ok(await service.listActive(request.query.kind));
  });

  app.get('/:slug', { schema: { tags, summary: 'Promoção e produtos abrangidos', params: slugParams, querystring: promotionProductsQuery } }, async (request) => {
    const { promotion, items, meta } = await service.getBySlug(request.params.slug, request.query);
    return ok({ promotion, products: items }, 'OK', meta);
  });
};

/** /api/v1/admin/promotions */
export const promotionsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Admin · Promotions & Coupons'];
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.authorize(PERMISSIONS.PROMOTIONS_MANAGE));

  app.get('/', { schema: { tags, summary: 'Listar promoções (ativas, agendadas, terminadas, desativadas)', querystring: adminPromotionsQuery } }, async (request) => {
    const { items, meta } = await service.adminList(request.query);
    return ok(items, 'OK', meta);
  });
  app.get('/:id', { schema: { tags, summary: 'Detalhe (+ nº de produtos abrangidos)', params: idParams } }, async (request) => ok(await service.adminGet(request.params.id)));
  app.post('/', { schema: { tags, summary: 'Criar promoção', body: createPromotionBody } }, async (request, reply) =>
    reply.code(201).send(ok(await service.create(auditContext(request), request.body), 'Promotion created successfully')),
  );
  app.patch('/:id', { schema: { tags, summary: 'Editar promoção', params: idParams, body: updatePromotionBody } }, async (request) =>
    ok(await service.update(auditContext(request), request.params.id, request.body), 'Promotion updated successfully'),
  );
  app.delete('/:id', { schema: { tags, summary: 'Remover promoção (soft delete)', params: idParams } }, async (request) => {
    await service.remove(auditContext(request), request.params.id);
    return ok(null, 'Promotion deleted successfully');
  });
};
