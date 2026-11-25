import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3333),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    API_URL: z.string().url().default('http://localhost:3333'),
    FRONTEND_URL: z.string().url().default('http://localhost:3000'),
    /** Lista separada por vírgulas. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    DOCS_ENABLED: bool.optional(),

    DATABASE_URL: z.string().min(1),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must have at least 32 characters'),
    JWT_ACCESS_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must have at least 32 characters'),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: bool.optional(),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
    RATE_LIMIT_ENABLED: bool.default('true'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW: z.string().default('1 minute'),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    STORAGE_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage/uploads'),
    STORAGE_PUBLIC_URL: z.string().url().default('http://localhost:3333/uploads'),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    CLOUDINARY_FOLDER: z.string().default('electro-shop'),
    UPLOAD_MAX_FILE_SIZE_MB: z.coerce.number().positive().max(25).default(5),
    UPLOAD_MAX_FILES: z.coerce.number().int().positive().max(20).default(10),

    EMAIL_PROVIDER: z.enum(['console']).default('console'),
    EMAIL_FROM: z.string().default('Electro Shop <no-reply@electroshop.local>'),

    DEFAULT_CURRENCY: z.string().length(3).default('MZN'),
    /** Fuso horário da loja para relatórios ("vendas de hoje", agrupamento por dia/mês). */
    STORE_TIMEZONE: z.string().default('Africa/Maputo'),
    TAX_RATE_PERCENT: z.coerce.number().min(0).max(100).default(16),
    TAX_INCLUDED_IN_PRICES: bool.default('true'),
    CART_MAX_QTY_PER_ITEM: z.coerce.number().int().positive().default(20),
    CART_GUEST_TTL_DAYS: z.coerce.number().int().positive().default(30),
    STOCK_RESERVATION_TTL_MINUTES: z.coerce.number().int().min(5).default(30),

    /** Segredo HMAC do gateway simulado (mock). Gateways reais têm o seu. */
    PAYMENT_MOCK_WEBHOOK_SECRET: z.string().min(16).optional(),

    JOBS_ENABLED: bool.default('true'),

    // Usados apenas pelo seed
    OWNER_NAME: z.string().default('Store Owner'),
    OWNER_EMAIL: z.string().email().optional(),
    OWNER_PASSWORD: z.string().min(10).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.STORAGE_DRIVER === 'cloudinary') {
      for (const k of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const) {
        if (!v[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when STORAGE_DRIVER=cloudinary` });
      }
    }
    if (v.COOKIE_SAMESITE === 'none' && v.COOKIE_SECURE === false) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'SameSite=None requires secure cookies' });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Não usar logger aqui: a configuração ainda não existe.
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const raw = parsed.data;
const isProd = raw.NODE_ENV === 'production';

export const env = {
  ...raw,
  isProd,
  isTest: raw.NODE_ENV === 'test',
  COOKIE_SECURE: raw.COOKIE_SECURE ?? isProd,
  DOCS_ENABLED: raw.DOCS_ENABLED ?? !isProd,
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
};

export type Env = typeof env;
