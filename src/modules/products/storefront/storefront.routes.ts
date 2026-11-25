import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../../../config/permissions';
import { WhatsAppSource } from '../../../db/client';
import { auditContext } from '../../../utils/audit';
import { ok } from '../../../utils/response';
import { adminBannersQuery, BannersService, createBannerBody, publicBannersQuery, updateBannerBody } from './banners.service';
import { SettingsService } from './settings.service';
import { visitorHash } from './whatsapp/whatsapp.analytics';
import { updateWhatsAppBody } from './whatsapp/whatsapp.config';
import { WhatsAppService } from './whatsapp/whatsapp.service';

const banners = new BannersService();
const settings = new SettingsService();
const whatsapp = new WhatsAppService();

const idParams = z.object({ id: z.string().uuid() });
const keyParams = z.object({ key: z.string().regex(/^[a-z_]{2,40}$/) });
const rangeQuery = z
  .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
  .transform((q) => {
    const to = q.to ?? new Date();
    return { to, from: q.from ?? new Date(to.getTime() - 30 * 86_400_000) };
  });

export const whatsAppLinkBody = z.object({
  source: z.nativeEnum(WhatsAppSource),
  productId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
  orderNumber: z.string().trim().regex(/^[A-Z0-9-]{6,30}$/).optional(),
});

/** /api/v1 — conteúdo público da loja: definições, banners, WhatsApp. */
export const storefrontRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Storefront'];

  app.get('/store/settings', { schema: { tags, summary: 'Informação pública da loja (nome, contactos, política de devoluções)' } }, async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return ok(await settings.publicSettings());
  });

  app.get('/banners', { schema: { tags, summary: 'Banners ativos por posição (HOMEPAGE, CATEGORY, PROMOTION, FLASH_SALE)', querystring: publicBannersQuery } }, async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=30');
    return ok(await banners.listPublic(request.query));
  });

  app.get('/whatsapp/config', { schema: { tags: ['WhatsApp'], summary: 'Configuração do botão WhatsApp (número nunca hardcoded no frontend)' } }, async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return ok(await whatsapp.publicConfig());
  });

  app.post(
    '/whatsapp/link',
    {
      preHandler: app.optionalAuth,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['WhatsApp'],
        summary: 'Gerar link wa.me contextualizado (produto, carrinho, checkout…) e registar o clique',
        description: 'A mensagem inclui nome, SKU, variante, preço atual e URL do produto — nunca dados do cliente.',
        body: whatsAppLinkBody,
      },
    },
    async (request) =>
      ok(await whatsapp.createLink(request.body, { userId: request.auth?.userId, visitorHash: visitorHash(request.ip, request.headers['user-agent']) })),
  );
};

/** /api/v1/admin — definições, banners e WhatsApp. */
export const storefrontAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const P = PERMISSIONS;
  app.addHook('preHandler', app.authenticate);

  // ---------------------------------------------------------------- settings (OWNER)
  const st = ['Admin · Settings'];
  app.get('/settings', { preHandler: app.authorize(P.SETTINGS_MANAGE), schema: { tags: st, summary: 'Todas as configurações e regras comerciais' } }, async () => ok(await settings.all()));
  app.get('/settings/:key', { preHandler: app.authorize(P.SETTINGS_MANAGE), schema: { tags: st, summary: 'Uma configuração', params: keyParams } }, async (request) =>
    ok(await settings.get(request.params.key)),
  );
  app.patch(
    '/settings/:key',
    { preHandler: app.authorize(P.SETTINGS_MANAGE), schema: { tags: st, summary: 'Alterar configuração (parcial, validada, auditada)', params: keyParams, body: z.record(z.unknown()) } },
    async (request) => ok(await settings.update(auditContext(request), request.params.key, request.body), 'Settings updated successfully'),
  );

  // ---------------------------------------------------------------- banners
  const bt = ['Admin · Content'];
  app.get('/banners', { preHandler: app.authorize(P.BANNERS_MANAGE), schema: { tags: bt, summary: 'Listar banners', querystring: adminBannersQuery } }, async (request) => {
    const { items, meta } = await banners.adminList(request.query);
    return ok(items, 'OK', meta);
  });
  app.post('/banners', { preHandler: app.authorize(P.BANNERS_MANAGE), schema: { tags: bt, summary: 'Criar banner', body: createBannerBody } }, async (request, reply) =>
    reply.code(201).send(ok(await banners.create(auditContext(request), request.body), 'Banner created successfully')),
  );
  app.patch('/banners/:id', { preHandler: app.authorize(P.BANNERS_MANAGE), schema: { tags: bt, summary: 'Editar banner', params: idParams, body: updateBannerBody } }, async (request) =>
    ok(await banners.update(auditContext(request), request.params.id, request.body), 'Banner updated successfully'),
  );
  app.delete('/banners/:id', { preHandler: app.authorize(P.BANNERS_MANAGE), schema: { tags: bt, summary: 'Remover banner (soft delete)', params: idParams } }, async (request) => {
    await banners.remove(auditContext(request), request.params.id);
    return ok(null, 'Banner deleted successfully');
  });

  // ---------------------------------------------------------------- WhatsApp
  const wt = ['Admin · WhatsApp'];
  app.get('/whatsapp', { preHandler: app.authorize(P.WHATSAPP_MANAGE), schema: { tags: wt, summary: 'Configuração do WhatsApp' } }, async () => ok(await whatsapp.adminGet()));
  app.patch('/whatsapp', { preHandler: app.authorize(P.WHATSAPP_MANAGE), schema: { tags: wt, summary: 'Alterar número, mensagens, horário, botão (auditado)', body: updateWhatsAppBody } }, async (request) =>
    ok(await whatsapp.adminUpdate(auditContext(request), request.body), 'WhatsApp settings updated successfully'),
  );
  app.get(
    '/whatsapp/analytics',
    { preHandler: app.authorize(P.REPORTS_READ), schema: { tags: wt, summary: 'Cliques por origem, produtos que geram mais contactos, evolução diária', querystring: rangeQuery } },
    async (request) => ok(await whatsapp.analytics(request.query.from, request.query.to)),
  );
};
