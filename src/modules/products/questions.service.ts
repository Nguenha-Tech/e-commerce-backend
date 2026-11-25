import { NotificationType, prisma, QuestionStatus, type Prisma } from '../../db/client';
import { recordAudit, type AuditContext } from '../../utils/audit';
import { Errors } from '../../utils/errors';
import { notify } from '../../utils/notifications';
import { pageMeta, toSkipTake } from '../../utils/pagination';
import { PUBLIC_STATUSES } from './products.service';
import { displayName } from './reviews.service';
import type { AdminQuestionsQuery } from './reviews.schemas';
import { getSetting } from './storefront/settings.service';

/** Perguntas e respostas sobre produtos ("Este carregador funciona com iPhone 15?"). */
export class QuestionsService {
  async listForProduct(productId: string, q: { page: number; limit: number }) {
    const where: Prisma.ProductQuestionWhereInput = { productId, status: QuestionStatus.PUBLISHED };
    const [total, rows] = await prisma.$transaction([
      prisma.productQuestion.count({ where }),
      prisma.productQuestion.findMany({
        where,
        select: { id: true, question: true, answer: true, answeredAt: true, createdAt: true, user: { select: { name: true } } },
        orderBy: [{ answeredAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        ...toSkipTake(q),
      }),
    ]);
    return { items: rows.map(({ user, ...r }) => ({ ...r, author: displayName(user.name) })), meta: pageMeta(total, q) };
  }

  async ask(userId: string, productId: string, question: string) {
    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null, status: { in: PUBLIC_STATUSES } }, select: { id: true } });
    if (!product) throw Errors.notFound('Product');
    // Evita duplicados por duplo clique.
    const dup = await prisma.productQuestion.findFirst({ where: { productId, userId, question, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (dup) return dup;
    const cfg = await getSetting('questions');
    return prisma.productQuestion.create({
      data: { productId, userId, question, status: cfg.requireApproval ? QuestionStatus.PENDING : QuestionStatus.PUBLISHED },
      select: { id: true, question: true, status: true, createdAt: true },
    });
  }

  async listMine(userId: string, q: { page: number; limit: number }) {
    const where = { userId };
    const [total, items] = await prisma.$transaction([
      prisma.productQuestion.count({ where }),
      prisma.productQuestion.findMany({
        where,
        select: { id: true, question: true, answer: true, answeredAt: true, status: true, createdAt: true, product: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async deleteMine(userId: string, id: string) {
    const res = await prisma.productQuestion.deleteMany({ where: { id, userId, answer: null } });
    if (res.count === 0) throw Errors.notFound('Question', 'QUESTION_NOT_FOUND_OR_ANSWERED');
  }

  // ------------------------------------------------------------------ admin
  async adminList(q: AdminQuestionsQuery) {
    const where: Prisma.ProductQuestionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.unanswered ? { answer: null } : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.productQuestion.count({ where }),
      prisma.productQuestion.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } }, product: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ answeredAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        ...toSkipTake(q),
      }),
    ]);
    return { items, meta: pageMeta(total, q) };
  }

  async answer(ctx: AuditContext, id: string, answer: string, publish: boolean) {
    const q = await prisma.productQuestion.findUnique({ where: { id }, include: { product: { select: { name: true, slug: true } } } });
    if (!q) throw Errors.notFound('Question');
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.productQuestion.update({
        where: { id },
        data: { answer, answeredAt: new Date(), answeredById: ctx.actorId, ...(publish ? { status: QuestionStatus.PUBLISHED } : {}) },
      });
      await recordAudit(tx, ctx, { action: 'question.answer', resourceType: 'ProductQuestion', resourceId: id, before: { answer: q.answer, status: q.status }, after: { answer, status: r.status } });
      return r;
    });
    if (!q.answer) {
      await notify({
        userId: q.userId,
        type: NotificationType.ACCOUNT,
        title: 'A sua pergunta foi respondida',
        body: `${q.product.name}: ${answer.slice(0, 200)}`,
        data: { questionId: id, slug: q.product.slug },
      });
    }
    return updated;
  }

  async setStatus(ctx: AuditContext, id: string, status: QuestionStatus) {
    const q = await prisma.productQuestion.findUnique({ where: { id } });
    if (!q) throw Errors.notFound('Question');
    return prisma.$transaction(async (tx) => {
      const r = await tx.productQuestion.update({ where: { id }, data: { status } });
      await recordAudit(tx, ctx, { action: 'question.moderate', resourceType: 'ProductQuestion', resourceId: id, before: { status: q.status }, after: { status } });
      return r;
    });
  }

  async remove(ctx: AuditContext, id: string) {
    const q = await prisma.productQuestion.findUnique({ where: { id } });
    if (!q) throw Errors.notFound('Question');
    await prisma.$transaction(async (tx) => {
      await tx.productQuestion.delete({ where: { id } });
      await recordAudit(tx, ctx, { action: 'question.delete', resourceType: 'ProductQuestion', resourceId: id, before: { question: q.question, answer: q.answer } });
    });
  }
}
