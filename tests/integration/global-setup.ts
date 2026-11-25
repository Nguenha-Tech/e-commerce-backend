import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { TEST_DATABASE_URL, testEnv } from '../test-env';

/**
 * Recria o schema da BD de testes a partir das migrações (as mesmas aplicadas em produção
 * por `prisma migrate deploy`) e corre o seed base (roles, permissões, OWNER, métodos).
 */
export default async function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`Refusing to reset "${dbName}": TEST_DATABASE_URL must point to a database whose name contains "test"`);

  Object.assign(process.env, testEnv);
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dir = join(__dirname, '../../src/db/migrations');
    const migrations = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const m of migrations) await client.query(readFileSync(join(dir, m, 'migration.sql'), 'utf8'));
  } finally {
    await client.end();
  }

  const seed = await import('../../src/db/seed');
  await seed.seedRbac();
  await seed.seedOwner();
  await seed.seedCategories();
  await seed.seedBrands();
  await seed.seedShippingAndPayments();
  await seed.seedStore();
  const { prisma } = await import('../../src/db/client');
  await prisma.$disconnect();
}
