import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { NotificationType, prisma, TokenType, UserStatus } from '../../db/client';
import { fakePasswordVerify, hashPassword, randomToken, sha256, verifyPassword } from '../../utils/crypto';
import { Errors } from '../../utils/errors';
import { getMailer } from '../../utils/mailer';
import { notify } from '../../utils/notifications';
import type { LoginInput, RegisterInput } from './auth.schemas';
import { frontendLinks } from '../../utils/frontend-links';

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  sessionId: string;
}

const EMAIL_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_MINUTES = 30;
const MAX_LOCK_MINUTES = 24 * 60;

const publicUserSelect = {
  id: true,
  name: true,
  username: true,
  email: true,
  phone: true,
  avatarUrl: true,
  emailVerifiedAt: true,
  createdAt: true,
  roles: { select: { role: { select: { name: true } } } },
} as const;

export class AuthService {
  constructor(private readonly app: FastifyInstance) {}

  // --------------------------------------------------------------- sessões
  private async createSession(userId: string, meta: ClientMeta): Promise<AuthTokens> {
    const refreshToken = randomToken(48);
    const session = await prisma.session.create({
      data: {
        userId,
        refreshTokenHash: sha256(refreshToken),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });
    return this.tokensFor(userId, session.id, refreshToken);
  }

  private tokensFor(userId: string, sessionId: string, refreshToken: string): AuthTokens {
    const accessToken = this.app.jwt.sign({ sub: userId, sid: sessionId });
    return { accessToken, refreshToken, sessionId, accessTokenExpiresIn: env.JWT_ACCESS_TTL_MINUTES * 60 };
  }

  // --------------------------------------------------------------- registo
  async register(input: RegisterInput, meta: ClientMeta) {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: input.email }, ...(input.phone ? [{ phone: input.phone }] : [])] },
      select: { email: true },
    });
    if (existing) {
      throw existing.email === input.email
        ? Errors.conflict('EMAIL_ALREADY_IN_USE', 'Email is already registered')
        : Errors.conflict('PHONE_ALREADY_IN_USE', 'Phone is already registered');
    }

    const customerRole = await prisma.role.findUnique({ where: { name: 'CUSTOMER' } });
    if (!customerRole) throw new Error('CUSTOMER role is missing — run the database seed');

    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash: await hashPassword(input.password),
        roles: { create: { roleId: customerRole.id } },
      },
      select: publicUserSelect,
    });

    await this.sendEmailVerification(user.id, user.email);
    const tokens = await this.createSession(user.id, meta);
    return { user: toPublicUser(user), tokens };
  }

  // --------------------------------------------------------------- login
  async login(input: LoginInput, meta: ClientMeta) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || user.deletedAt) {
      await fakePasswordVerify(input.password);
      throw Errors.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw Errors.locked('ACCOUNT_TEMPORARILY_LOCKED', 'Too many failed attempts. Try again later.', {
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const over = attempts - env.LOGIN_MAX_ATTEMPTS;
      const lockMinutes = over >= 0 ? Math.min(env.LOGIN_LOCK_MINUTES * 2 ** over, MAX_LOCK_MINUTES) : 0;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lockMinutes ? new Date(Date.now() + lockMinutes * 60_000) : null,
        },
      });
      this.app.log.warn({ userId: user.id, attempts, ip: meta.ip }, 'failed login');
      throw Errors.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }

    // Estado só é revelado depois de a password estar certa.
    if (user.status === UserStatus.BLOCKED) throw Errors.forbidden('Account is blocked', 'ACCOUNT_BLOCKED');
    if (user.status !== UserStatus.ACTIVE) throw Errors.forbidden('Account is disabled', 'ACCOUNT_DISABLED');

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const tokens = await this.createSession(user.id, meta);
    const full = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: publicUserSelect });
    return { user: toPublicUser(full), tokens };
  }

  // --------------------------------------------------------------- refresh (rotação)
  async refresh(refreshToken: string, meta: ClientMeta): Promise<AuthTokens> {
    const hash = sha256(refreshToken);
    const session = await prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { select: { status: true, deletedAt: true } } },
    });

    if (!session) {
      // Token antigo reapresentado => provável roubo: revogar a família inteira.
      const reused = await prisma.session.findUnique({ where: { previousTokenHash: hash } });
      if (reused && !reused.revokedAt) {
        await prisma.session.update({ where: { id: reused.id }, data: { revokedAt: new Date(), revokedReason: 'TOKEN_REUSE' } });
        this.app.log.warn({ sessionId: reused.id, userId: reused.userId, ip: meta.ip }, 'refresh token reuse detected');
      }
      throw Errors.unauthorized('Refresh token is invalid', reused ? 'REFRESH_TOKEN_REUSED' : 'INVALID_REFRESH_TOKEN');
    }
    if (session.revokedAt || session.expiresAt < new Date()) {
      throw Errors.unauthorized('Session expired, please log in again', 'SESSION_EXPIRED');
    }
    if (session.user.deletedAt || session.user.status !== UserStatus.ACTIVE) {
      throw Errors.forbidden('Account is not active', 'ACCOUNT_NOT_ACTIVE');
    }

    const next = randomToken(48);
    // Update condicional: dois refresh concorrentes com o mesmo token => só um ganha.
    const { count } = await prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
      data: { previousTokenHash: hash, refreshTokenHash: sha256(next), lastUsedAt: new Date(), ip: meta.ip ?? session.ip },
    });
    if (count === 0) throw Errors.unauthorized('Refresh token is invalid', 'INVALID_REFRESH_TOKEN');
    return this.tokensFor(session.userId, session.id, next);
  }

  // --------------------------------------------------------------- logout / sessões
  async logout(sessionId: string) {
    await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'LOGOUT' } });
  }

  async logoutByRefreshToken(refreshToken: string) {
    await prisma.session.updateMany({
      where: { refreshTokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
  }

  async logoutAll(userId: string, exceptSessionId?: string, reason = 'LOGOUT_ALL') {
    await prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  listSessions(userId: string, currentSessionId: string) {
    return prisma.session
      .findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true, expiresAt: true },
        orderBy: { lastUsedAt: 'desc' },
      })
      .then((rows) => rows.map((s) => ({ ...s, current: s.id === currentSessionId })));
  }

  async revokeSession(userId: string, sessionId: string) {
    const { count } = await prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
    });
    if (count === 0) throw Errors.notFound('Session');
  }

  // --------------------------------------------------------------- email
  private async createOneTimeToken(userId: string, type: TokenType, ttlMs: number) {
    const token = randomToken(32);
    await prisma.$transaction([
      // Só o token mais recente de cada tipo é válido.
      prisma.verificationToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.verificationToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } }),
    ]);
    return token;
  }

  private async consumeToken(token: string, type: TokenType) {
    const record = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.type !== type || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.badRequest('INVALID_OR_EXPIRED_TOKEN', 'The link is invalid or has expired');
    }
    const { count } = await prisma.verificationToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count === 0) throw Errors.badRequest('INVALID_OR_EXPIRED_TOKEN', 'The link is invalid or has expired');
    return record;
  }

  async sendEmailVerification(userId: string, email: string) {
    const token = await this.createOneTimeToken(userId, TokenType.EMAIL_VERIFICATION, EMAIL_TOKEN_TTL_HOURS * 3_600_000);
    await getMailer().send({
      to: email,
      subject: 'Confirme o seu email',
      text: `Confirme o seu email: ${frontendLinks.verifyEmail(token)}`,
    });
  }

  async resendVerification(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) throw Errors.badRequest('EMAIL_ALREADY_VERIFIED', 'Email is already verified');
    await this.sendEmailVerification(user.id, user.email);
  }

  async verifyEmail(token: string) {
    const record = await this.consumeToken(token, TokenType.EMAIL_VERIFICATION);
    await prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
  }

  // --------------------------------------------------------------- passwords
  /** Resposta sempre igual (não revela se o email existe). */
  async forgotPassword(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) return;
    const token = await this.createOneTimeToken(user.id, TokenType.PASSWORD_RESET, RESET_TOKEN_TTL_MINUTES * 60_000);
    await getMailer().send({
      to: user.email,
      subject: 'Recuperação de palavra-passe',
      text: `Para definir uma nova palavra-passe (válido ${RESET_TOKEN_TTL_MINUTES} min): ${frontendLinks.resetPassword(token)}`,
    });
  }

  async resetPassword(token: string, newPassword: string) {
    const record = await this.consumeToken(token, TokenType.PASSWORD_RESET);
    await prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    });
    await this.logoutAll(record.userId, undefined, 'PASSWORD_RESET');
    await notify({
      userId: record.userId,
      type: NotificationType.PASSWORD_CHANGED,
      title: 'Palavra-passe alterada',
      body: 'A sua palavra-passe foi redefinida. Se não foi você, contacte o suporte.',
      email: true,
    });
  }

  async changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw Errors.badRequest('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() } });
    await this.logoutAll(userId, sessionId, 'PASSWORD_CHANGED'); // termina as outras sessões
    await notify({
      userId,
      type: NotificationType.PASSWORD_CHANGED,
      title: 'Palavra-passe alterada',
      body: 'A sua palavra-passe foi alterada. Se não foi você, contacte o suporte.',
      email: true,
    });
  }
}

type PublicUserRow = {
  id: string;
  name: string;
  username: string | null;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  roles: { role: { name: string } }[];
};

export function toPublicUser(u: PublicUserRow) {
  const { roles, ...rest } = u;
  return { ...rest, emailVerified: Boolean(u.emailVerifiedAt), roles: roles.map((r) => r.role.name) };
}
