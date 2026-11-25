import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { env } from '../../config/env';
import { Errors } from '../../utils/errors';
import { ok } from '../../utils/response';
import { mergeGuestCart } from '../orders/cart.service';
import {
  CART_COOKIE,
  clearAuthCookies,
  clearCartCookie,
  isMobileClient,
  REFRESH_COOKIE,
  requestMeta,
  setAuthCookies,
} from './auth.cookies';
import {
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  refreshBody,
  registerBody,
  resetPasswordBody,
  sessionIdParams,
  verifyEmailBody,
} from './auth.schemas';
import { AuthService, type AuthTokens } from './auth.service';

const strictLimit = { rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new AuthService(app);
  const tags = ['Auth'];

  /** Web: tokens em cookies HTTP-only. Mobile: tokens também no corpo. */
  function tokenPayload(request: FastifyRequest, reply: FastifyReply, tokens: AuthTokens) {
    setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      ...(isMobileClient(request) ? { refreshToken: tokens.refreshToken } : {}),
    };
  }

  /** Funde o carrinho de visitante no carrinho do utilizador após login/registo. */
  async function mergeCart(request: FastifyRequest, reply: FastifyReply, userId: string) {
    const guestToken = request.cookies[CART_COOKIE];
    if (!guestToken) return;
    try {
      await mergeGuestCart(userId, guestToken);
    } catch (err) {
      request.log.warn({ err }, 'guest cart merge failed');
    }
    clearCartCookie(reply);
  }

  app.post('/register', { config: strictLimit, schema: { tags, summary: 'Criar conta', body: registerBody } }, async (request, reply) => {
    const { user, tokens } = await service.register(request.body, requestMeta(request));
    await mergeCart(request, reply, user.id);
    return reply.code(201).send(ok({ user, ...tokenPayload(request, reply, tokens) }, 'Account created successfully'));
  });

  app.post('/login', { config: strictLimit, schema: { tags, summary: 'Login', body: loginBody } }, async (request, reply) => {
    const { user, tokens } = await service.login(request.body, requestMeta(request));
    await mergeCart(request, reply, user.id);
    return ok({ user, ...tokenPayload(request, reply, tokens) }, 'Logged in successfully');
  });

  app.post(
    '/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { tags, summary: 'Renovar sessão (rotação do refresh token)', body: refreshBody } },
    async (request, reply) => {
      const token = request.body?.refreshToken ?? request.cookies[REFRESH_COOKIE];
      if (!token) throw Errors.unauthorized('Refresh token missing', 'REFRESH_TOKEN_MISSING');
      try {
        const tokens = await service.refresh(token, requestMeta(request));
        return ok(tokenPayload(request, reply, tokens), 'Session refreshed');
      } catch (err) {
        clearAuthCookies(reply);
        throw err;
      }
    },
  );

  app.post('/logout', { schema: { tags, summary: 'Terminar a sessão atual', body: refreshBody } }, async (request, reply) => {
    // Funciona mesmo com access token expirado (usa o refresh token).
    await app.optionalAuth.call(app, request, reply);
    if (request.auth) await service.logout(request.auth.sessionId);
    else {
      const token = request.body?.refreshToken ?? request.cookies[REFRESH_COOKIE];
      if (token) await service.logoutByRefreshToken(token);
    }
    clearAuthCookies(reply);
    return ok(null, 'Logged out successfully');
  });

  app.post('/logout-all', { preHandler: app.authenticate, schema: { tags, summary: 'Terminar todas as sessões' } }, async (request, reply) => {
    await service.logoutAll(request.auth!.userId);
    clearAuthCookies(reply);
    return ok(null, 'All sessions terminated');
  });

  app.get('/sessions', { preHandler: app.authenticate, schema: { tags, summary: 'Listar sessões ativas' } }, async (request) =>
    ok(await service.listSessions(request.auth!.userId, request.auth!.sessionId)),
  );

  app.delete(
    '/sessions/:id',
    { preHandler: app.authenticate, schema: { tags, summary: 'Revogar uma sessão', params: sessionIdParams } },
    async (request) => {
      await service.revokeSession(request.auth!.userId, request.params.id);
      return ok(null, 'Session revoked');
    },
  );

  app.post(
    '/forgot-password',
    { config: strictLimit, schema: { tags, summary: 'Pedir recuperação de password', body: forgotPasswordBody } },
    async (request) => {
      await service.forgotPassword(request.body.email);
      return ok(null, 'If the email exists, a recovery link has been sent');
    },
  );

  app.post('/reset-password', { config: strictLimit, schema: { tags, summary: 'Definir nova password', body: resetPasswordBody } }, async (request) => {
    await service.resetPassword(request.body.token, request.body.password);
    return ok(null, 'Password reset successfully');
  });

  app.post(
    '/change-password',
    { preHandler: app.authenticate, config: strictLimit, schema: { tags, summary: 'Alterar password', body: changePasswordBody } },
    async (request) => {
      await service.changePassword(request.auth!.userId, request.auth!.sessionId, request.body.currentPassword, request.body.newPassword);
      return ok(null, 'Password changed successfully');
    },
  );

  app.post('/verify-email', { config: strictLimit, schema: { tags, summary: 'Confirmar email', body: verifyEmailBody } }, async (request) => {
    await service.verifyEmail(request.body.token);
    return ok(null, 'Email verified successfully');
  });

  app.post(
    '/resend-verification',
    { preHandler: app.authenticate, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Reenviar email de confirmação' } },
    async (request) => {
      await service.resendVerification(request.auth!.userId);
      return ok(null, 'Verification email sent');
    },
  );
};
