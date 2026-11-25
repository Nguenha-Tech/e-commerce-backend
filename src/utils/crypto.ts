import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

// Parâmetros recomendados pela OWASP para Argon2id.
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, ARGON_OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Verificação "falsa" para igualar o tempo de resposta quando o utilizador não existe. */
export async function fakePasswordVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equalizer-password');
  await verifyPassword(await dummyHash, password);
}

/** Token opaco URL-safe. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const hmacSha256Hex = (secret: string, payload: Buffer | string) =>
  createHmac('sha256', secret).update(payload).digest('hex');

/** Comparação em tempo constante de strings hexadecimais/ASCII. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
