import { z } from 'zod';
import { QuestionStatus, ReviewStatus } from '../../db/client';
import { paginationQuery } from '../../utils/pagination';

export const productIdParams = z.object({ id: z.string().uuid() });
export const idParams = z.object({ id: z.string().uuid() });

/** Chave gerada pelo próprio servidor no upload (reviews/AAAA/MM/<uuid>.webp). */
const reviewImageKey = z.string().regex(/^reviews\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/, 'Invalid image key');

// ------------------------------------------------------------------ reviews
export const createReviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(2).max(120).optional(),
  comment: z.string().trim().min(3).max(3000).optional(),
  images: z.array(z.object({ storageKey: reviewImageKey })).max(10).default([]),
});

export const updateReviewBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(2).max(120).nullable(),
    comment: z.string().trim().min(3).max(3000).nullable(),
  })
  .partial()
  .strict();

export const listReviewsQuery = paginationQuery.extend({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  withPhotos: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['newest', 'rating_desc', 'rating_asc']).default('newest'),
});

export const reportReviewBody = z.object({ reason: z.string().trim().min(3).max(300) });

export const adminReviewsQuery = paginationQuery.extend({
  status: z.nativeEnum(ReviewStatus).optional(),
  productId: z.string().uuid().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  reported: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  unanswered: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const moderateReviewBody = z.object({
  status: z.enum([ReviewStatus.APPROVED, ReviewStatus.HIDDEN, ReviewStatus.REJECTED]),
  note: z.string().trim().max(300).optional(),
});

export const replyBody = z.object({ reply: z.string().trim().min(2).max(2000) });

// ------------------------------------------------------------------ perguntas
export const createQuestionBody = z.object({ question: z.string().trim().min(5).max(1000) });

export const adminQuestionsQuery = paginationQuery.extend({
  status: z.nativeEnum(QuestionStatus).optional(),
  productId: z.string().uuid().optional(),
  unanswered: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const answerQuestionBody = z.object({
  answer: z.string().trim().min(1).max(2000),
  publish: z.boolean().default(true),
});

export const questionStatusBody = z.object({ status: z.nativeEnum(QuestionStatus) });

export type CreateReviewInput = z.infer<typeof createReviewBody>;
export type UpdateReviewInput = z.infer<typeof updateReviewBody>;
export type ListReviewsQuery = z.infer<typeof listReviewsQuery>;
export type AdminReviewsQuery = z.infer<typeof adminReviewsQuery>;
export type AdminQuestionsQuery = z.infer<typeof adminQuestionsQuery>;
