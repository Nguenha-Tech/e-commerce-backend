import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { PERMISSIONS } from '../../config/permissions';
import { prisma } from '../../db/client';
import { auditContext } from '../../utils/audit';
import { ok } from '../../utils/response';
import { resolveLines } from './lines';
import { OrdersService } from './orders.service';
import {
  adminListOrdersQuery,
  cancelOrderBody,
  checkoutBody,
  confirmPaymentBody,
  idempotencyHeaders,
  idParams,
  listOrdersQuery,
  orderPaymentParams,
  retryPaymentBody,
  shippingQuery,
  updateOrderStatusBody,
  webhookParams,
} from './orders.schemas';
import { PaymentsService } from './payments/payments.service';
import { ShippingService } from './shipping.service';

const orders = new OrdersService();
const payments = new PaymentsService();
const shipping = new ShippingService();

/** /api/v1 — checkout, pedidos do cliente, métodos de entrega e pagamento. */
export const ordersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/shipping/methods', { preHandler: app.optionalAuth, schema: { tags: ['Checkout & Orders'], summary: 'Métodos de entrega e preços para um endereço', querystring: shippingQuery } }, async (request) => {
    let address = null;
    let ctx = { subtotal: 0, weightGrams: 0 };
    if (request.auth) {
      if (request.query.addressId) {
        address = await prisma.address.findFirst({ where: { id: request.query.addressId, userId: request.auth.userId, deletedAt: null } });
      }
      // Preço depende do subtotal (portes grátis) e do peso do carrinho.
      const cart = await prisma.cart.findUnique({ where: { userId: request.auth.userId }, include: { items: true } });
      if (cart) {
        const lines = (await resolveLines(cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })))).filter((l) => !l.issue);
        ctx = { subtotal: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0), weightGrams: lines.reduce((s, l) => s + l.weightGrams, 0) };
      }
    }
    return ok(await shipping.options(address, ctx));
  });

  app.get('/payments/methods', { schema: { tags: ['Payments'], summary: 'Métodos de pagamento disponíveis' } }, async () => ok(await payments.listMethods()));

  // Rotas autenticadas
  await app.register(async (scope) => {
    const auth = scope.withTypeProvider<ZodTypeProvider>();
    auth.addHook('preHandler', app.authenticate);
    const tags = ['Checkout & Orders'];

    auth.post('/checkout/quote', { schema: { tags, summary: 'Resumo do checkout calculado no servidor', body: checkoutBody } }, async (request) =>
      ok(await orders.quote(request.auth!.userId, request.body)),
    );

    auth.post(
      '/orders',
      {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: {
          tags,
          summary: 'Confirmar e criar pedido (requer header Idempotency-Key)',
          description: 'Valida produto, variante, preço, stock, cupão e entrega; reserva stock; cria o pedido e inicia o pagamento. Repetir com a mesma Idempotency-Key devolve o mesmo pedido.',
          headers: idempotencyHeaders,
          body: checkoutBody,
        },
      },
      async (request, reply) => {
        const result = await orders.placeOrder(request.auth!.userId, request.body, request.headers['idempotency-key']);
        return reply.code(result.created ? 201 : 200).send(ok(result, result.created ? 'Order created successfully' : 'Order already created'));
      },
    );

    auth.get('/orders', { schema: { tags, summary: 'Histórico de compras', querystring: listOrdersQuery } }, async (request) => {
      const { items, meta } = await orders.listMine(request.auth!.userId, request.query);
      return ok(items, 'OK', meta);
    });

    auth.get('/orders/:id', { schema: { tags, summary: 'Detalhe e acompanhamento do pedido', params: idParams } }, async (request) =>
      ok(await orders.getMine(request.auth!.userId, request.params.id)),
    );

    auth.post('/orders/:id/cancel', { schema: { tags, summary: 'Cancelar pedido (antes da preparação)', params: idParams, body: cancelOrderBody } }, async (request) =>
      ok(await orders.cancelMine(request.auth!.userId, request.params.id, request.body.reason), 'Order cancelled'),
    );

    auth.post(
      '/orders/:id/payments',
      { schema: { tags: ['Payments'], summary: 'Nova tentativa de pagamento (Idempotency-Key)', params: idParams, headers: idempotencyHeaders, body: retryPaymentBody } },
      async (request, reply) =>
        reply.code(201).send(ok(await payments.retry(request.auth!.userId, request.params.id, request.headers['idempotency-key'], request.body?.paymentMethodCode), 'Payment initiated')),
    );
  });
};

/** /api/v1/payments/webhooks/:provider — corpo bruto para validar a assinatura HMAC. */
export const paymentWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

  app.post(
    '/:provider',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } }, schema: { tags: ['Payments'], summary: 'Webhook de gateway de pagamento (assinatura obrigatória)', params: webhookParams } },
    async (request) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
      const result = await payments.handleWebhook(request.params.provider, request.headers, raw);
      return ok(result, result.duplicate ? 'Event already processed' : 'Event received');
    },
  );
};

/** /api/v1/admin/orders */
export const ordersAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['Admin · Orders'];
  const P = PERMISSIONS;
  app.addHook('preHandler', app.authenticate);

  app.get('/', { preHandler: app.authorize(P.ORDERS_READ), schema: { tags, summary: 'Listar pedidos (filtros: estado, pagamento, datas, pesquisa)', querystring: adminListOrdersQuery } }, async (request) => {
    const { items, meta } = await orders.adminList(request.query);
    return ok(items, 'OK', meta);
  });

  app.get('/:id', { preHandler: app.authorize(P.ORDERS_READ), schema: { tags, summary: 'Detalhe (pagamentos, transações, reservas, histórico)', params: idParams } }, async (request) =>
    ok(await orders.adminGet(request.params.id)),
  );

  app.patch('/:id/status', { preHandler: app.authorize(P.ORDERS_MANAGE), schema: { tags, summary: 'Alterar estado (transições validadas)', params: idParams, body: updateOrderStatusBody } }, async (request) =>
    ok(await orders.adminUpdateStatus(auditContext(request), request.params.id, request.body), 'Order status updated'),
  );

  app.post(
    '/:id/payments/:paymentId/confirm',
    { preHandler: app.authorize(P.PAYMENTS_MANAGE), schema: { tags, summary: 'Confirmar pagamento manual (transferência / na entrega)', params: orderPaymentParams, body: confirmPaymentBody } },
    async (request) => {
      const res = await payments.confirmManually(auditContext(request), request.params.id, request.params.paymentId, request.body.note);
      return ok(await orders.adminGet(res.orderId), res.alreadyPaid ? 'Payment was already confirmed' : 'Payment confirmed');
    },
  );
};
