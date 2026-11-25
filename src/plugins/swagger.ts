import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { env } from '../config/env';

export default fp(
  async (app) => {
    if (!env.DOCS_ENABLED) return;

    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Electro Shop API',
          description:
            'API do e-commerce de eletrónicos. Valores monetários em centavos (inteiros). ' +
            'Autenticação: cookie HTTP-only `access_token` (web) ou `Authorization: Bearer` (mobile).',
          version: '1.0.0',
        },
        servers: [{ url: env.API_URL }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            cookieAuth: { type: 'apiKey', in: 'cookie', name: 'access_token' },
          },
        },
        tags: [
          { name: 'Auth' }, { name: 'Users' }, { name: 'Catalog' }, { name: 'Cart' },
          { name: 'Checkout & Orders' }, { name: 'Payments' },
          { name: 'Admin · Catalog' }, { name: 'Admin · Inventory' }, { name: 'Admin · Orders' },
          { name: 'Admin · Users & Roles' }, { name: 'Admin · Uploads' }, { name: 'Health' },
        ],
      },
      transform: jsonSchemaTransform,
    });

    await app.register(swaggerUi, { routePrefix: '/docs' });
  },
  { name: 'swagger' },
);
