import { z } from 'zod';
import { RecordStatus } from '../../db/client';

export const idParams = z.object({ id: z.string().uuid() });
export const slugParams = z.object({ slug: z.string().trim().min(1).max(140) });

const slugField = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug').max(140);

export const createCategoryBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugField.optional(),
  description: z.string().trim().max(2000).optional(),
  imageUrl: z.string().url().max(500).optional(),
  parentId: z.string().uuid().nullable().optional(),
  status: z.nativeEnum(RecordStatus).default(RecordStatus.ACTIVE),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  metaTitle: z.string().trim().max(70).optional(),
  metaDescription: z.string().trim().max(170).optional(),
});

export const updateCategoryBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: slugField,
    description: z.string().trim().max(2000).nullable(),
    imageUrl: z.string().url().max(500).nullable(),
    parentId: z.string().uuid().nullable(),
    status: z.nativeEnum(RecordStatus),
    sortOrder: z.number().int().min(0).max(10_000),
    metaTitle: z.string().trim().max(70).nullable(),
    metaDescription: z.string().trim().max(170).nullable(),
  })
  .partial()
  .strict();

export type CreateCategoryInput = z.infer<typeof createCategoryBody>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryBody>;
