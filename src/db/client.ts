import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';
import { Prisma, PrismaClient } from './generated/client';

export { Prisma };
export * from './generated/enums';

function createClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    // Erros chegam ao handler global (que os regista com o requestId). Conflitos esperados
    // (P2002 em idempotência/duplicados) são tratados no código e não devem poluir os logs.
    log: env.isTest ? [] : ['warn'],
  });
}

/** Instância única (pool partilhado) usada pelos serviços. */
export const prisma = createClient();

export type DbClient = typeof prisma;
/** Cliente utilizável dentro e fora de `$transaction`. */
export type Db = DbClient | Prisma.TransactionClient;
