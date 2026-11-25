import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { env } from './config/env';
import { prisma } from './db/client';
import { authRoutes } from './modules/auth/auth.routes';
import { categoriesAdminRoutes, categoriesRoutes } from './modules/categories/categories.routes';
import { cartRoutes } from './modules/orders/cart.routes';
import { managementAdminRoutes } from './modules/orders/management.routes';
import { returnsAdminRoutes, returnsRoutes } from './modules/orders/returns.routes';
import { ordersAdminRoutes, ordersRoutes, paymentWebhookRoutes } from './modules/orders/orders.routes';
import { productsAdminRoutes } from './modules/products/products.admin.routes';
import { promotionsAdminRoutes, promotionsRoutes } from './modules/products/promotions.routes';
import { reviewsAdminRoutes, reviewsRoutes } from './modules/products/reviews.routes';
import { storefrontAdminRoutes, storefrontRoutes } from './modules/products/storefront/storefront.routes';
import { brandsRoutes, productsRoutes } from './modules/products/products.routes';
import { uploadsAdminRoutes } from './modules/uploads/uploads.routes';
import { accountAdminRoutes, notificationsRoutes, wishlistRoutes } from './modules/users/account.routes';
import { usersAdminRoutes, usersRoutes } from './modules/users/users.routes';
import authPlugin from './plugins/auth';
import errorHandler from './plugins/error-handler';
import jobsPlugin from './plugins/jobs';
import prismaPlugin from './plugins/prisma';
import securityPlugin from './plugins/security';
import storagePlugin from './plugins/storage';
import swaggerPlugin from './plugins/swagger';

export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Nunca registar credenciais, tokens ou cookies.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.newPassword',
          '*.currentPassword',
          '*.token',
          '*.refreshToken',
          '*.accessToken',
        ],
        censor: '[REDACTED]',
      },
      ...(env.NODE_ENV === 'development' && !env.isServerless ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
    },
    // Correlation ID: reaproveita X-Request-Id do proxy/cliente ou gera um UUID.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: env.isProd || env.isServerless,
    bodyLimit: 1024 * 1024,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(errorHandler);
  await app.register(prismaPlugin);
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(storagePlugin);
  await app.register(swaggerPlugin);
  await app.register(jobsPlugin);

  // ---------------------------------------------------------------- health
  app.get('/health', { schema: { tags: ['Health'], summary: 'Liveness' }, config: { rateLimit: false } }, async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', { schema: { tags: ['Health'], summary: 'Readiness (base de dados)' }, config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }
  });

  // ---------------------------------------------------------------- API v1
  await app.register(
    async (v1) => {
      // Público / cliente
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(usersRoutes, { prefix: '/users' });
      await v1.register(categoriesRoutes, { prefix: '/categories' });
      await v1.register(productsRoutes, { prefix: '/products' });
      await v1.register(brandsRoutes, { prefix: '/brands' });
      await v1.register(reviewsRoutes);
      await v1.register(promotionsRoutes, { prefix: '/promotions' });
      await v1.register(storefrontRoutes);
      await v1.register(wishlistRoutes, { prefix: '/wishlist' });
      await v1.register(notificationsRoutes, { prefix: '/notifications' });
      await v1.register(cartRoutes, { prefix: '/cart' });
      await v1.register(ordersRoutes);
      await v1.register(returnsRoutes);
      await v1.register(paymentWebhookRoutes, { prefix: '/payments/webhooks' });

      // Administração (sempre authenticate + authorize)
      await v1.register(
        async (admin) => {
          await admin.register(usersAdminRoutes);
          await admin.register(accountAdminRoutes);
          await admin.register(reviewsAdminRoutes);
          await admin.register(promotionsAdminRoutes, { prefix: '/promotions' });
          await admin.register(storefrontAdminRoutes);
          await admin.register(productsAdminRoutes);
          await admin.register(categoriesAdminRoutes, { prefix: '/categories' });
          await admin.register(ordersAdminRoutes, { prefix: '/orders' });
          await admin.register(returnsAdminRoutes, { prefix: '/returns' });
          await admin.register(managementAdminRoutes);
          await admin.register(uploadsAdminRoutes, { prefix: '/uploads' });
        },
        { prefix: '/admin' },
      );
    },
    { prefix: '/api/v1' },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
