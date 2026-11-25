import { prisma, type Prisma } from '../../db/client';
import { Errors } from '../../utils/errors';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import type { AuditQuery } from './account.schemas';

/** Consulta dos audit logs (só leitura — os registos são imutáveis via API). */
export class AuditService {
  async list(q: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      ...(q.resourceId ? { resourceId: q.resourceId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, action: true, resourceType: true, resourceId: true, actorId: true, actorEmail: true,
          ip: true, requestId: true, createdAt: true, before: true, after: true,
          actor: { select: { name: true } },
        },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async get(id: string) {
    const log = await prisma.auditLog.findUnique({ where: { id }, include: { actor: { select: { id: true, name: true, email: true } } } });
    if (!log) throw Errors.notFound('Audit log');
    return log;
  }

  /** Lista de ações distintas para filtros no painel. */
  async actions() {
    const rows = await prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { action: 'asc' } });
    return rows.map((r) => ({ action: r.action, count: r._count._all }));
  }
}
