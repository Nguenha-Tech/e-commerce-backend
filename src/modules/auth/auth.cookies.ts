import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { ACCESS_COOKIE } from '../../plugins/auth';

export const REFRESH_COOKIE = 'refresh_token';
export const CART_COOKIE = 'cart_token';
const REFRESH_PATH = '/api/v1/auth';

const base = (): CookieSerializeOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  domain: env.COOKIE_DOMAIN,
});

export function setAuthCookies(reply: FastifyReply, accessToken: string, refreshToken: string) {
  reply.setCookie(ACCESS_COOKIE, accessToken, { ...base(), path: '/', maxAge: env.JWT_ACCESS_TTL_MINUTES * 60 });
  reply.setCookie(REFRESH_COOKIE, refreshToken, {
    ...base(),
    path: REFRESH_PATH, // o refresh token só viaja para as rotas de auth
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400,
  });
}

export function clearAuthCookies(reply: FastifyReply) {
  reply.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  reply.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_PATH });
}

export function setCartCookie(reply: FastifyReply, token: string) {
  reply.setCookie(CART_COOKIE, token, { ...base(), path: '/', maxAge: env.CART_GUEST_TTL_DAYS * 86_400 });
}

export function clearCartCookie(reply: FastifyReply) {
  reply.clearCookie(CART_COOKIE, { ...base(), path: '/' });
}

/** Clientes mobile recebem o refresh token no corpo (não usam cookies). */
export const isMobileClient = (request: FastifyRequest) => request.headers['x-client-type'] === 'mobile';

export function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent']?.slice(0, 500) };
}
