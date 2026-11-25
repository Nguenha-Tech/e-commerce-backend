/**
 * Ambiente dos testes. As integrações usam SEMPRE uma base de dados própria
 * (TEST_DATABASE_URL) que é apagada e recriada a cada execução.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/shop_test';

export const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-0123456789-abcdefghijklmnop',
  COOKIE_SECRET: 'test-cookie-secret-0123456789-abcdefghijklmn',
  PAYMENT_MOCK_WEBHOOK_SECRET: 'test-mock-webhook-secret',
  RATE_LIMIT_ENABLED: 'false',
  JOBS_ENABLED: 'false',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: './storage/test-uploads',
  OWNER_NAME: 'Test Owner',
  OWNER_EMAIL: 'owner@test.local',
  OWNER_PASSWORD: 'Owner-Test-Password-1',
  TAX_RATE_PERCENT: '16',
  TAX_INCLUDED_IN_PRICES: 'true',
};
