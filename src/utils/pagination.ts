import { z } from 'zod';
import type { PageMeta } from './response';

export const MAX_PAGE_SIZE = 100;

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function toSkipTake({ page, limit }: Pagination) {
  return { skip: (page - 1) * limit, take: limit };
}

export function pageMeta(total: number, { page, limit }: Pagination): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
