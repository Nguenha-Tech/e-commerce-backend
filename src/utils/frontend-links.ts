import { env } from '../config/env';

/**
 * Links para páginas do frontend (emails, WhatsApp, SEO). Um único sítio para as rotas,
 * alinhado com o frontend estático (páginas .html com parâmetros de query).
 */
const base = () => env.FRONTEND_URL.replace(/\/$/, '');

export const frontendLinks = {
  product: (slug: string) => `${base()}/product.html?slug=${encodeURIComponent(slug)}`,
  verifyEmail: (token: string) => `${base()}/verify-email.html?token=${encodeURIComponent(token)}`,
  resetPassword: (token: string) => `${base()}/reset-password.html?token=${encodeURIComponent(token)}`,
};
