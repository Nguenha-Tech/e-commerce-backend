import jwt from '@fastify/jwt';
import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../config/env';
import type { Permission } from '../config/permissions';
import { prisma, UserStatus } from '../db/client';
import { Errors } from '../utils/errors';
import type { AuthContext } from '../types/fastify';

export const ACCESS_COOKIE = 'access_token';

/** Valida a sessão na BD e carrega roles/permissões (efeito imediato de logout/bloqueio). */
async function loadAuthContext(userId: string, sessionId: string): Promise<AuthContext | null> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      user: {
        select: {
          id: true,
          email: true,
          status: true,
          deletedAt: true,
          roles: {
            select: {
              role: { select: { name: true, level: true, permissions: { select: { permission: { select: { key: true } } } } } },
            },
          },
        },
      },
    },
  });
  const user = session?.user;
  if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) return null;

  const permissions = new Set<string>();
  let roleLevel = 0;
  for (const { role } of user.roles) {
    roleLevel = Math.max(roleLevel, role.level);
    for (const rp of role.permissions) permissions.add(rp.permission.key);
  }
  return {
    userId: user.id,
    sessionId,
    email: user.email,
    roles: user.roles.map((r) => r.role.name),
    roleLevel,
    permissions,
  };
}

async function resolve(request: FastifyRequest): Promise<AuthContext> {
  let payload: { sub: string; sid: string };
  try {
    payload = await request.jwtVerify();
  } catch {
    throw Errors.unauthorized('Invalid or expired access token', 'INVALID_ACCESS_TOKEN');
  }
  const ctx = await loadAuthContext(payload.sub, payload.sid);
  if (!ctx) throw Errors.unauthorized('Session is no longer valid', 'SESSION_INVALID');
  return ctx;
}

function hasToken(request: FastifyRequest) {
  return Boolean(request.headers.authorization || request.cookies?.[ACCESS_COOKIE]);
}

export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: env.JWT_SECRET,
      sign: { expiresIn: `${env.JWT_ACCESS_TTL_MINUTES}m` },
      // Cookie (web) com fallback para Authorization: Bearer (mobile).
      cookie: { cookieName: ACCESS_COOKIE, signed: false },
    });

    app.decorateRequest('auth', undefined);

    app.decorate('authenticate', async (request: FastifyRequest) => {
      if (!hasToken(request)) throw Errors.unauthorized();
      request.auth = await resolve(request);
    });

    app.decorate('optionalAuth', async (request: FastifyRequest) => {
      if (!hasToken(request)) return;
      try {
        request.auth = await resolve(request);
      } catch {
        request.auth = undefined;
      }
    });

    app.decorate('authorize', (...required: Permission[]) => async (request: FastifyRequest) => {
      if (!request.auth) throw Errors.unauthorized();
      const missing = required.filter((p) => !request.auth!.permissions.has(p));
      if (missing.length > 0) {
        request.log.warn({ userId: request.auth.userId, missing }, 'permission denied');
        throw Errors.forbidden();
      }
    });
  },
  { name: 'auth', dependencies: ['security'] },
);
