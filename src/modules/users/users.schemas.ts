import { z } from 'zod';
import { AddressType, UserStatus } from '../../db/client';
import { paginationQuery } from '../../utils/pagination';
import { emailSchema, passwordSchema, phoneSchema } from '../auth/auth.schemas';

export const idParams = z.object({ id: z.string().uuid() });

export const updateProfileBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,40}$/, 'Username: 3-40 chars, letters, numbers, _ or .').nullable(),
    phone: phoneSchema.nullable(),
    avatarUrl: z.string().url().max(500).nullable(),
    country: z.string().trim().max(80).nullable(),
    province: z.string().trim().max(80).nullable(),
    city: z.string().trim().max(80).nullable(),
    birthDate: z.coerce
      .date()
      .refine((d) => d < new Date() && d > new Date('1900-01-01'), 'Invalid birth date')
      .nullable(),
  })
  .partial()
  .strict();

const addressFields = {
  label: z.string().trim().max(60).optional(),
  type: z.nativeEnum(AddressType).default(AddressType.HOME),
  recipientName: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  country: z.string().trim().min(2).max(80).default('Moçambique'),
  province: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  neighborhood: z.string().trim().max(120).optional(),
  street: z.string().trim().min(2).max(200),
  number: z.string().trim().max(20).optional(),
  reference: z.string().trim().max(300).optional(),
  postalCode: z.string().trim().max(20).optional(),
  isDefault: z.boolean().default(false),
};

export const createAddressBody = z.object(addressFields).strict();
// .partial() envolve cada campo em ZodOptional, que devolve undefined sem aplicar
// os defaults — um PATCH nunca sobrescreve valores não enviados.
export const updateAddressBody = z.object(addressFields).partial().strict();

export const listUsersQuery = paginationQuery.extend({
  search: z.string().trim().max(100).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

export const blockUserBody = z.object({ reason: z.string().trim().min(3).max(300) });

export const createStaffBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: phoneSchema.optional(),
  password: passwordSchema,
  roles: z.array(z.string().trim().min(2).max(50)).min(1).max(10),
});

export const setRolesBody = z.object({ roles: z.array(z.string().trim().min(2).max(50)).min(1).max(10) });

const roleName = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,49}$/, 'Role name: A-Z, 0-9, _');

export const createRoleBody = z.object({
  name: roleName,
  description: z.string().trim().max(300).optional(),
  level: z.number().int().min(1).max(99),
  permissions: z.array(z.string().max(80)).max(200).default([]),
});

export const updateRoleBody = z
  .object({
    description: z.string().trim().max(300).nullable(),
    level: z.number().int().min(1).max(99),
    permissions: z.array(z.string().max(80)).max(200),
  })
  .partial();

export type UpdateProfileInput = z.infer<typeof updateProfileBody>;
export type CreateAddressInput = z.infer<typeof createAddressBody>;
export type UpdateAddressInput = z.infer<typeof updateAddressBody>;
