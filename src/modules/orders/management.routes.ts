import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../../config/permissions';
import { RefundStatus } from '../../db/client';
import { auditContext } from '../../utils/audit';
import { paginationQuery } from '../../utils/pagination';
import { ok } from '../../utils/response';
import { adminCouponsQuery, CouponsAdminService, createCouponBody, updateCouponBody } from './coupons.admin.service';
import {
  createPaymentMethodBody,
  createShippingMethodBody,
  createShippingRateBody,
  MethodsAdminService,
  updatePaymentMethodBody,
  updateShippingMethodBody,
  updateShippingRateBody,
} from './methods.admin.service';
import { idempotencyHeaders } from './orders.schemas';
import { RefundsService } from './payments/refunds.service';
import { rankedReportQuery, reportRangeQuery, ReportsService } from './reports.service';

const coupons = new CouponsAdminService();
const methods = new MethodsAdminService();
const refunds = new RefundsService();
const reports = new ReportsService();

const idParams = z.object({ id: z.string().uuid() });
const P = PERMISSIONS;

/** /api/v1/admin — cupões, métodos de entrega/pagamento, reembolsos, dashboard e relatórios. */
export const managementAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // ---------------------------------------------------------------- cupões
  const ct = ['Admin · Promotions & Coupons'];
  app.get('/coupons', { preHandler: app.authorize(P.COUPONS_MANAGE), schema: { tags: ct, summary: 'Listar cupões (válidos, agendados, expirados, esgotados)', querystring: adminCouponsQuery } }, async (request) => {
    const { items, meta } = await coupons.list(request.query);
    return ok(items, 'OK', meta);
  });
  app.get('/coupons/:id', { preHandler: app.authorize(P.COUPONS_MANAGE), schema: { tags: ct, summary: 'Detalhe + estatísticas de uso', params: idParams } }, async (request) => ok(await coupons.get(request.params.id)));
  app.get('/coupons/:id/usages', { preHandler: app.authorize(P.COUPONS_MANAGE), schema: { tags: ct, summary: 'Utilizações (cliente, pedido, desconto)', params: idParams, querystring: paginationQuery } }, async (request) => {
    const { items, meta } = await coupons.usages(request.params.id, request.query);
    return ok(items, 'OK', meta);
  });
  app.post('/coupons', { preHandler: app.authorize(P.COUPONS_MANAGE), schema: { tags: ct, summary: 'Criar cupão', body: createCouponBody } }, async (request, reply) =>
    reply.code(201).send(ok(await coupons.create(auditContext(request), request.body), 'Coupon created successfully')),
  );
  app.patch('/coupons/:id', { preHandler: app.authorize(P.COUPONS_MANAGE), schema: { tags: ct, summary: 'Editar cupão', params: idParams, body: updateCouponBody } }, async (request) =>
    ok(await coupons.update(auditContext(request), request.params.id, request.body), 'Coupon updated successfully'),
  );
  app.delete('/coupons/:id', { preHandler: app.authorize(P.COUPONS_MANAGE), schema: { tags: ct, summary: 'Remover cupão (soft delete)', params: idParams } }, async (request) => {
    await coupons.remove(auditContext(request), request.params.id);
    return ok(null, 'Coupon deleted successfully');
  });

  // ---------------------------------------------------------------- entrega (OWNER)
  const st = ['Admin · Shipping & Payment methods'];
  app.get('/shipping-methods', { preHandler: app.authorize(P.SHIPPING_METHODS_MANAGE), schema: { tags: st, summary: 'Métodos de entrega e tarifas por região' } }, async () => ok(await methods.listShipping()));
  app.post('/shipping-methods', { preHandler: app.authorize(P.SHIPPING_METHODS_MANAGE), schema: { tags: st, summary: 'Criar método de entrega', body: createShippingMethodBody } }, async (request, reply) =>
    reply.code(201).send(ok(await methods.createShipping(auditContext(request), request.body), 'Shipping method created successfully')),
  );
  app.patch('/shipping-methods/:id', { preHandler: app.authorize(P.SHIPPING_METHODS_MANAGE), schema: { tags: st, summary: 'Editar / ativar / desativar', params: idParams, body: updateShippingMethodBody } }, async (request) =>
    ok(await methods.updateShipping(auditContext(request), request.params.id, request.body), 'Shipping method updated successfully'),
  );
  app.post('/shipping-methods/:id/rates', { preHandler: app.authorize(P.SHIPPING_METHODS_MANAGE), schema: { tags: st, summary: 'Adicionar tarifa (país / província / cidade)', params: idParams, body: createShippingRateBody } }, async (request, reply) =>
    reply.code(201).send(ok(await methods.addRate(auditContext(request), request.params.id, request.body), 'Shipping rate created successfully')),
  );
  app.patch('/shipping-rates/:id', { preHandler: app.authorize(P.SHIPPING_METHODS_MANAGE), schema: { tags: st, summary: 'Editar tarifa', params: idParams, body: updateShippingRateBody } }, async (request) =>
    ok(await methods.updateRate(auditContext(request), request.params.id, request.body), 'Shipping rate updated successfully'),
  );
  app.delete('/shipping-rates/:id', { preHandler: app.authorize(P.SHIPPING_METHODS_MANAGE), schema: { tags: st, summary: 'Remover tarifa', params: idParams } }, async (request) => {
    await methods.deleteRate(auditContext(request), request.params.id);
    return ok(null, 'Shipping rate deleted successfully');
  });

  // ---------------------------------------------------------------- pagamento (OWNER)
  app.get('/payment-methods', { preHandler: app.authorize(P.PAYMENT_METHODS_MANAGE), schema: { tags: st, summary: 'Métodos de pagamento + providers instalados' } }, async () => ok(await methods.listPayment()));
  app.post('/payment-methods', { preHandler: app.authorize(P.PAYMENT_METHODS_MANAGE), schema: { tags: st, summary: 'Criar método de pagamento (sem segredos no config)', body: createPaymentMethodBody } }, async (request, reply) =>
    reply.code(201).send(ok(await methods.createPayment(auditContext(request), request.body), 'Payment method created successfully')),
  );
  app.patch('/payment-methods/:id', { preHandler: app.authorize(P.PAYMENT_METHODS_MANAGE), schema: { tags: st, summary: 'Editar / ativar / desativar', params: idParams, body: updatePaymentMethodBody } }, async (request) =>
    ok(await methods.updatePayment(auditContext(request), request.params.id, request.body), 'Payment method updated successfully'),
  );

  // ---------------------------------------------------------------- reembolsos
  const rt = ['Admin · Returns & Refunds'];
  app.get(
    '/refunds',
    { preHandler: app.authorize(P.REFUNDS_MANAGE), schema: { tags: rt, summary: 'Listar reembolsos', querystring: paginationQuery.extend({ status: z.nativeEnum(RefundStatus).optional() }) } },
    async (request) => {
      const { items, meta } = await refunds.list(request.query);
      return ok(items, 'OK', meta);
    },
  );
  app.post(
    '/payments/:id/refunds',
    {
      preHandler: app.authorize(P.REFUNDS_MANAGE),
      schema: {
        tags: rt,
        summary: 'Criar reembolso (total ou parcial; header Idempotency-Key)',
        params: idParams,
        headers: idempotencyHeaders,
        body: z.object({ amount: z.number().int().positive(), reason: z.string().trim().min(3).max(300) }),
      },
    },
    async (request, reply) => {
      const res = await refunds.create(auditContext(request), { paymentId: request.params.id, ...request.body }, request.headers['idempotency-key']);
      return reply.code(res.created ? 201 : 200).send(ok(res.refund, res.created ? 'Refund created' : 'Refund already exists'));
    },
  );
  app.post(
    '/refunds/:id/process',
    {
      preHandler: app.authorize(P.REFUNDS_MANAGE),
      schema: {
        tags: rt,
        summary: 'Processar reembolso (gateway automático ou registo manual com referência)',
        params: idParams,
        body: z.object({ providerReference: z.string().trim().max(120).optional(), note: z.string().trim().max(300).optional() }),
      },
    },
    async (request) => {
      const res = await refunds.process(auditContext(request), request.params.id, request.body);
      return ok(res.refund, res.alreadyCompleted ? 'Refund was already completed' : 'Refund processed');
    },
  );
  app.post(
    '/refunds/:id/fail',
    { preHandler: app.authorize(P.REFUNDS_MANAGE), schema: { tags: rt, summary: 'Marcar reembolso como falhado', params: idParams, body: z.object({ reason: z.string().trim().min(3).max(200) }) } },
    async (request) => ok(await refunds.fail(auditContext(request), request.params.id, request.body.reason), 'Refund marked as failed'),
  );

  // ---------------------------------------------------------------- dashboard
  app.get(
    '/dashboard',
    {
      preHandler: app.authorize(P.DASHBOARD_READ),
      schema: { tags: ['Admin · Dashboard & Reports'], summary: 'Indicadores (vendas, pedidos, stock baixo, top produtos/categorias); bloco financeiro só com reports:financial' },
    },
    async (request) => ok(await reports.dashboard(request.auth!.permissions.has(P.REPORTS_FINANCIAL))),
  );

  // ---------------------------------------------------------------- relatórios
  await app.register(
    async (instance) => {
      const r = instance.withTypeProvider<ZodTypeProvider>();
      const tags = ['Admin · Dashboard & Reports'];
      const fin = (request: { auth?: { permissions: Set<string> } }) => request.auth!.permissions.has(P.REPORTS_FINANCIAL);
      const q = { querystring: reportRangeQuery };

      r.get('/sales', { preHandler: app.authorize(P.REPORTS_READ), schema: { tags, summary: 'Vendas por período (dia/semana/mês/ano ou intervalo)', ...q } }, async (request) => ok(await reports.sales(request.query)));
      r.get('/products', { preHandler: app.authorize(P.REPORTS_READ), schema: { tags, summary: 'Produtos e categorias mais vendidos (custo/lucro com reports:financial)', querystring: rankedReportQuery } }, async (request) => {
        const { items, meta, ...rest } = await reports.products(request.query, request.query, fin(request));
        return ok({ ...rest, items }, 'OK', meta);
      });
      r.get('/stock', { preHandler: app.authorize(P.REPORTS_READ, P.INVENTORY_READ), schema: { tags, summary: 'Stock atual e movimentos no período', ...q } }, async (request) => ok(await reports.stock(request.query, fin(request))));
      r.get('/customers', { preHandler: app.authorize(P.REPORTS_READ, P.CUSTOMERS_READ), schema: { tags, summary: 'Novos clientes, recorrência, melhores clientes', ...q } }, async (request) => ok(await reports.customers(request.query)));
      r.get('/orders', { preHandler: app.authorize(P.REPORTS_READ), schema: { tags, summary: 'Pedidos por estado, pagamento, entrega; taxa de cancelamento', ...q } }, async (request) => ok(await reports.orders(request.query)));
      r.get('/discounts', { preHandler: app.authorize(P.REPORTS_READ), schema: { tags, summary: 'Descontos de produto e cupões', ...q } }, async (request) => ok(await reports.discounts(request.query)));
      r.get('/returns', { preHandler: app.authorize(P.REPORTS_READ), schema: { tags, summary: 'Devoluções por estado/motivo, taxa de devolução', ...q } }, async (request) => ok(await reports.returns(request.query)));
      // Financeiros (OWNER / MANAGER)
      r.get('/revenue', { preHandler: app.authorize(P.REPORTS_FINANCIAL), schema: { tags, summary: 'Receita bruta/líquida, reembolsos, custo, lucro (financeiro)', ...q } }, async (request) => ok(await reports.revenue(request.query)));
      r.get('/payments', { preHandler: app.authorize(P.REPORTS_FINANCIAL), schema: { tags, summary: 'Pagamentos por método/estado, taxa de sucesso (financeiro)', ...q } }, async (request) => ok(await reports.payments(request.query)));
    },
    { prefix: '/reports' },
  );
};
