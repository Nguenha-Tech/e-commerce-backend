import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { auditContext } from '../../utils/audit';
import { ok } from '../../utils/response';
import { UploadsService } from '../uploads/uploads.service';
import {
  adminListReturnsQuery,
  approveReturnBody,
  createReturnBody,
  listReturnsQuery,
  receiveReturnBody,
  refundReturnBody,
  rejectReturnBody,
  ReturnsService,
} from './returns.service';

const idParams = z.object({ id: z.string().uuid() });

/** /api/v1 — devoluções do cliente. */
export const returnsRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ReturnsService(app.storage);
  const uploads = new UploadsService(app.storage);
  const tags = ['Returns'];
  app.addHook('preHandler', app.authenticate);

  app.post(
    '/orders/:id/returns',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags, summary: 'Pedir devolução (pedido entregue, dentro do prazo)', params: idParams, body: createReturnBody } },
    async (request, reply) => reply.code(201).send(ok(await service.create(request.auth!.userId, request.params.id, request.body), 'Return requested successfully')),
  );

  app.post(
    '/returns/evidence',
    {
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
      schema: { tags, summary: 'Upload de fotografias/evidências (multipart, campo "file"); devolve storageKey', consumes: ['multipart/form-data'] },
    },
    async (request, reply) => {
      const { files } = await uploads.uploadFromRequest(request, 'returns');
      return reply.code(201).send(ok(files.map((f) => ({ storageKey: f.storageKey, url: f.url })), 'Evidence uploaded successfully'));
    },
  );

  app.get('/returns', { schema: { tags, summary: 'As minhas devoluções', querystring: listReturnsQuery } }, async (request) => {
    const { items, meta } = await service.listMine(request.auth!.userId, request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/returns/:id', { schema: { tags, summary: 'Detalhe da devolução', params: idParams } }, async (request) => ok(await service.getMine(request.auth!.userId, request.params.id)));

  app.post('/returns/:id/cancel', { schema: { tags, summary: 'Cancelar pedido de devolução (antes da recolha)', params: idParams } }, async (request) =>
    ok(await service.cancelMine(request.auth!.userId, request.params.id), 'Return cancelled'),
  );
};

/** /api/v1/admin/returns */
export const returnsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ReturnsService(app.storage);
  const P = PERMISSIONS;
  const tags = ['Admin · Returns & Refunds'];
  app.addHook('preHandler', app.authenticate);

  app.get('/', { preHandler: app.authorize(P.ORDERS_READ), schema: { tags, summary: 'Listar devoluções', querystring: adminListReturnsQuery } }, async (request) => {
    const { items, meta } = await service.adminList(request.query);
    return ok(items, 'OK', meta);
  });
  app.get('/:id', { preHandler: app.authorize(P.ORDERS_READ), schema: { tags, summary: 'Detalhe', params: idParams } }, async (request) => ok(await service.adminGet(request.params.id)));

  app.post('/:id/review', { preHandler: app.authorize(P.ORDERS_MANAGE), schema: { tags, summary: 'Colocar em análise', params: idParams } }, async (request) =>
    ok(await service.startReview(auditContext(request), request.params.id), 'Return under review'),
  );
  app.post('/:id/approve', { preHandler: app.authorize(P.ORDERS_MANAGE), schema: { tags, summary: 'Aprovar (e agendar recolha)', params: idParams, body: approveReturnBody } }, async (request) =>
    ok(await service.approve(auditContext(request), request.params.id, request.body), 'Return approved'),
  );
  app.post('/:id/reject', { preHandler: app.authorize(P.ORDERS_MANAGE), schema: { tags, summary: 'Rejeitar', params: idParams, body: rejectReturnBody } }, async (request) =>
    ok(await service.reject(auditContext(request), request.params.id, request.body.reason), 'Return rejected'),
  );
  app.post('/:id/cancel', { preHandler: app.authorize(P.ORDERS_MANAGE), schema: { tags, summary: 'Cancelar devolução', params: idParams } }, async (request) =>
    ok(await service.adminCancel(auditContext(request), request.params.id), 'Return cancelled'),
  );
  app.post(
    '/:id/receive',
    { preHandler: app.authorize(P.ORDERS_MANAGE, P.INVENTORY_MANAGE), schema: { tags, summary: 'Registar receção (estado de cada artigo; repor stock ou não)', params: idParams, body: receiveReturnBody } },
    async (request) => ok(await service.receive(auditContext(request), request.params.id, request.body), 'Returned items received'),
  );
  app.post(
    '/:id/refund',
    {
      preHandler: app.authorize(P.REFUNDS_MANAGE),
      schema: {
        tags,
        summary: 'Reembolsar devolução (idempotente por devolução)',
        description: 'Gateways com reembolso automático são chamados diretamente; nos restantes (transferência, dinheiro) indique `providerReference` da devolução feita.',
        params: idParams,
        body: refundReturnBody.extend({ providerReference: z.string().trim().max(120).optional() }),
      },
    },
    async (request) => ok(await service.refund(auditContext(request), request.params.id, request.body), 'Refund processed'),
  );
};
