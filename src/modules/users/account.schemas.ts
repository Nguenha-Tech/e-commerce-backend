import { z } from 'zod';
import { NotificationType } from '../../db/client';
import { paginationQuery } from '../../utils/pagination';

export const productIdParams = z.object({ productId: z.string().uuid() });
export const variantIdParams = z.object({ variantId: z.string().uuid() });
export const idParams = z.object({ id: z.string().uuid() });

export const addWishlistItemBody = z.object({
  productId: z.string().uuid(),
  /** Variante preferida (ex.: cor). Opcional. */
  variantId: z.string().uuid().optional(),
  /** Criar também alerta "avise-me quando voltar ao stock". */
  notifyWhenAvailable: z.boolean().default(false),
});

export const stockAlertBody = z.object({ variantId: z.string().uuid() });

export const listNotificationsQuery = paginationQuery.extend({
  unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  type: z.nativeEnum(NotificationType).optional(),
});

export const auditQuery = paginationQuery.extend({
  actorId: z.string().uuid().optional(),
  action: z.string().trim().max(80).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type AddWishlistItemInput = z.infer<typeof addWishlistItemBody>;
export type AuditQuery = z.infer<typeof auditQuery>;
