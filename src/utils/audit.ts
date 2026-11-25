import type { FastifyRequest } from 'fastify';
import { Prisma, type Db } from '../db/client';

export interface AuditContext {
  actorId?: string;
  actorEmail?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditEntry {
  action: string; // ex.: product.update, user.block, inventory.adjust
  resourceType: string; // ex.: Product, User, Inventory
  resourceId?: string;
  before?: unknown;
  after?: unknown;
}

const SENSITIVE_KEYS = new Set(['passwordHash', 'password', 'refreshTokenHash', 'previousTokenHash', 'tokenHash', 'token']);

/** Remove campos sensíveis e converte para JSON seguro antes de gravar. */
function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, v) => (SENSITIVE_KEYS.has(key) ? '[REDACTED]' : typeof v === 'bigint' ? v.toString() : v)),
  );
}

export function auditContext(request: FastifyRequest): AuditContext {
  return {
    actorId: request.auth?.userId,
    actorEmail: request.auth?.email,
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500),
    requestId: String(request.id),
  };
}

/** Grava no mesmo cliente/transação da alteração para que ambos sejam atómicos. */
export async function recordAudit(db: Db, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: ctx.actorId,
      actorEmail: ctx.actorEmail,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: sanitize(entry.before),
      after: sanitize(entry.after),
    },
  });
}

/** Devolve apenas os campos que mudaram (para before/after compactos). */
export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const nv = after[key];
    if (nv === undefined) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(nv)) {
      b[key] = before[key];
      a[key] = nv;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
