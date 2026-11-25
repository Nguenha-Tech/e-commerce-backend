import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import { env } from '../config/env';

export default fp(
  async (app) => {
    await app.register(helmet, {
      // A API só serve JSON; a UI do Swagger precisa de inline scripts/styles.
      contentSecurityPolicy: env.DOCS_ENABLED
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
            },
          }
        : undefined,
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // imagens servidas a outros domínios
    });

    await app.register(cors, {
      origin: (origin, cb) => {
        // Pedidos sem Origin (apps mobile, curl, server-to-server) são permitidos.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Client-Type'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });

    await app.register(cookie, { secret: env.COOKIE_SECRET });

    if (!env.RATE_LIMIT_ENABLED) return; // ex.: testes de integração com muitos pedidos do mesmo IP
    await app.register(rateLimit, {
      global: true,
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW,
      // Em produção atrás de proxy, configurar trustProxy no app.ts.
      keyGenerator: (req) => req.ip,
    });
  },
  { name: 'security' },
);
