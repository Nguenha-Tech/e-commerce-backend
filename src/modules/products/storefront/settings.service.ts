import { z } from 'zod';
import { prisma, type Prisma } from '../../../db/client';
import { recordAudit, type AuditContext } from '../../../utils/audit';
import { TtlCache } from '../../../utils/cache';
import { Errors } from '../../../utils/errors';

/**
 * Configurações da loja e regras comerciais editáveis pelo OWNER (settings:manage).
 * Cada chave tem schema Zod e valores por omissão — a BD guarda só o que foi alterado.
 * Segredos NUNCA vivem aqui (ficam em variáveis de ambiente / secret manager).
 */
export const SETTINGS_SCHEMAS = {
  store: z.object({
    name: z.string().trim().min(2).max(80),
    legalName: z.string().trim().max(120).nullable(),
    taxId: z.string().trim().max(30).nullable(),
    email: z.string().email().nullable(),
    phone: z.string().trim().max(20).nullable(),
    address: z.string().trim().max(300).nullable(),
    logoUrl: z.string().url().nullable(),
  }),
  reviews: z.object({
    /** false => avaliações publicadas de imediato (podem ser ocultadas depois). */
    requireApproval: z.boolean(),
    allowPhotos: z.boolean(),
    maxPhotos: z.number().int().min(0).max(10),
  }),
  questions: z.object({ requireApproval: z.boolean() }),
  returns: z.object({
    enabled: z.boolean(),
    /** Dias após a entrega em que é possível pedir devolução. */
    windowDays: z.number().int().min(0).max(365),
    reasons: z.array(z.string().trim().min(2).max(80)).min(1).max(20),
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_SCHEMAS)[K]>;

export const SETTINGS_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  store: { name: 'Electro Shop', legalName: null, taxId: null, email: null, phone: null, address: null, logoUrl: null },
  reviews: { requireApproval: false, allowPhotos: true, maxPhotos: 5 },
  questions: { requireApproval: true },
  returns: {
    enabled: true,
    windowDays: 14,
    reasons: ['Produto com defeito', 'Produto diferente do anunciado', 'Produto danificado no transporte', 'Já não preciso', 'Outro'],
  },
};

/** Chaves que podem ser lidas sem autenticação (o frontend precisa delas). */
const PUBLIC_KEYS: SettingKey[] = ['store', 'returns'];

export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS_SCHEMAS;

const cache = new TtlCache<unknown>(60_000);

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  return (await cache.getOrSet(key, async () => {
    const row = await prisma.storeSetting.findUnique({ where: { key } });
    // Valores guardados são fundidos com os defaults (novos campos ganham default).
    const merged = { ...SETTINGS_DEFAULTS[key], ...((row?.value as object | null) ?? {}) };
    const parsed = SETTINGS_SCHEMAS[key].safeParse(merged);
    return parsed.success ? parsed.data : SETTINGS_DEFAULTS[key];
  })) as SettingValue<K>;
}

export class SettingsService {
  async all() {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS_SCHEMAS) as SettingKey[]) out[key] = await getSetting(key);
    return out;
  }

  async publicSettings() {
    const out: Record<string, unknown> = {};
    for (const key of PUBLIC_KEYS) out[key] = await getSetting(key);
    return out;
  }

  async get(key: string) {
    if (!isSettingKey(key)) throw Errors.notFound('Setting');
    return getSetting(key);
  }

  /** Atualização parcial validada; auditada com antes/depois. */
  async update(ctx: AuditContext, key: string, patch: unknown) {
    if (!isSettingKey(key)) throw Errors.notFound('Setting');
    const schema = SETTINGS_SCHEMAS[key];
    const partial = (schema as z.AnyZodObject).partial().strict().safeParse(patch);
    if (!partial.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid setting value', partial.error.flatten());

    const before = await getSetting(key);
    const next = schema.parse({ ...before, ...partial.data });
    await prisma.$transaction(async (tx) => {
      await tx.storeSetting.upsert({
        where: { key },
        update: { value: next as Prisma.InputJsonValue, updatedById: ctx.actorId },
        create: { key, value: next as Prisma.InputJsonValue, updatedById: ctx.actorId },
      });
      await recordAudit(tx, ctx, { action: 'settings.update', resourceType: 'StoreSetting', resourceId: key, before, after: next });
    });
    cache.clear();
    return next;
  }
}
