import { z } from 'zod';
import { prisma, WhatsAppSource, type Prisma } from '../../../../db/client';
import { diffFields, recordAudit, type AuditContext } from '../../../../utils/audit';
import { TtlCache } from '../../../../utils/cache';
import { Errors } from '../../../../utils/errors';
import { DAY_KEYS } from './whatsapp.message-builder';

/**
 * WhatsAppConfiguration — leitura (com cache) e alteração validada/auditada.
 * Só quem tem whatsapp:manage altera o número oficial. Tokens da Business API
 * (fase futura) ficam em variáveis de ambiente, nunca nesta tabela nem no frontend.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const slot = z.tuple([time, time]).refine(([a, b]) => a < b, 'Opening time must be before closing time').nullable();

export const businessHoursSchema = z.object({
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone').default('Africa/Maputo'),
  days: z.object(Object.fromEntries(DAY_KEYS.map((d) => [d, slot.optional()])) as Record<(typeof DAY_KEYS)[number], z.ZodOptional<typeof slot>>).default({}),
});

const phone = z.string().trim().regex(/^\d{6,12}$/, 'Digits only, without country code');
const countryCode = z.string().trim().regex(/^\d{1,4}$/, 'Digits only, e.g. 258');

export const updateWhatsAppBody = z
  .object({
    isEnabled: z.boolean(),
    countryCode,
    phoneNumber: phone,
    alternativeNumbers: z.array(z.object({ label: z.string().trim().min(2).max(40), countryCode, phoneNumber: phone })).max(5),
    defaultMessage: z.string().trim().min(5).max(500),
    welcomeMessage: z.string().trim().max(500).nullable(),
    awayMessage: z.string().trim().max(500).nullable(),
    businessHours: businessHoursSchema,
    contextMessages: z.object(Object.fromEntries(Object.values(WhatsAppSource).map((s) => [s, z.string().trim().min(5).max(500).optional()])) as Record<WhatsAppSource, z.ZodOptional<z.ZodString>>).strict(),
    buttonText: z.string().trim().min(2).max(60),
    buttonPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left', 'inline']),
  })
  .partial()
  .strict();

export type UpdateWhatsAppInput = z.infer<typeof updateWhatsAppBody>;
export type WhatsAppConfigRow = Prisma.WhatsAppConfigGetPayload<object>;

const cache = new TtlCache<WhatsAppConfigRow | null>(60_000);

export async function loadWhatsAppConfig(): Promise<WhatsAppConfigRow | null> {
  return cache.getOrSet('config', () => prisma.whatsAppConfig.findFirst({ orderBy: { updatedAt: 'desc' } }));
}

export async function updateWhatsAppConfig(ctx: AuditContext, input: UpdateWhatsAppInput): Promise<WhatsAppConfigRow> {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.whatsAppConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const data = { ...input, updatedById: ctx.actorId } as Prisma.WhatsAppConfigUncheckedCreateInput;
    let saved: WhatsAppConfigRow;
    if (current) {
      saved = await tx.whatsAppConfig.update({ where: { id: current.id }, data });
    } else {
      if (!input.phoneNumber || !input.defaultMessage) {
        throw Errors.badRequest('WHATSAPP_CONFIG_INCOMPLETE', 'phoneNumber and defaultMessage are required');
      }
      saved = await tx.whatsAppConfig.create({ data });
    }
    const diff = current ? diffFields(current as unknown as Record<string, unknown>, input as Record<string, unknown>) : { before: {}, after: input, changed: true };
    if (diff.changed) await recordAudit(tx, ctx, { action: 'whatsapp.update', resourceType: 'WhatsAppConfig', resourceId: saved.id, before: diff.before, after: diff.after });
    return saved;
  });
  cache.clear();
  return result;
}
