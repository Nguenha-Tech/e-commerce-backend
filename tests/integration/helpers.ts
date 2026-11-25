import { randomUUID } from 'node:crypto';
import { buildApp, type App } from '../../src/app';
import { prisma, ProductStatus } from '../../src/db/client';
import { refreshProductAggregates } from '../../src/modules/products/aggregates';
import { MockGatewayProvider } from '../../src/modules/orders/payments/providers';
import { testEnv } from '../test-env';

export { prisma };

export interface CallOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export async function createTestApp() {
  const app = await buildApp({ logger: false });
  await app.ready();

  const call = async (method: string, url: string, opts: CallOptions = {}): Promise<CallResult> => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: { 'x-client-type': 'mobile', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
    let json: unknown;
    try {
      json = res.json();
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json };
  };

  const login = async (email: string, password: string) => {
    const res = await call('POST', '/auth/login', { body: { email, password } });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.json)}`);
    return res.json.data.accessToken as string;
  };

  const ownerToken = () => login(testEnv.OWNER_EMAIL!, testEnv.OWNER_PASSWORD!);

  /** Cliente novo com endereço principal em Maputo. */
  const createCustomer = async (name = 'Cliente Teste') => {
    const email = `c-${randomUUID().slice(0, 8)}@test.mz`;
    const password = 'Senha-Forte-2026!';
    const reg = await call('POST', '/auth/register', { body: { name, email, password } });
    if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.json)}`);
    const token = await login(email, password);
    const addr = await call('POST', '/users/me/addresses', {
      token,
      body: { recipientName: name, phone: '+258841112233', country: 'Moçambique', province: 'Maputo Cidade', city: 'Maputo', street: 'Av. 24 de Julho', type: 'HOME', isDefault: true },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { token, email, password, userId: user.id, addressId: addr.json.data.id as string };
  };

  /** Staff com uma role existente (ex.: ADMIN). */
  const createStaff = async (role: string) => {
    const owner = await ownerToken();
    const email = `s-${randomUUID().slice(0, 8)}@test.mz`;
    const password = 'Staff-Password-2026!';
    const res = await call('POST', '/admin/staff', { token: owner, body: { name: `Staff ${role}`, email, password, roles: [role] } });
    if (res.status !== 201) throw new Error(`createStaff failed: ${JSON.stringify(res.json)}`);
    return { token: await login(email, password), userId: res.json.data.id as string, email };
  };

  return { app, call, login, ownerToken, createCustomer, createStaff };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Produto ACTIVE com uma variante e o stock indicado (preço em centavos). */
export async function createProduct(opts: { stock: number; price?: number; costPrice?: number; name?: string } = { stock: 10 }) {
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'carregadores' } });
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const product = await prisma.product.create({
    data: {
      name: opts.name ?? `Produto Teste ${suffix}`,
      slug: `produto-teste-${suffix.toLowerCase()}`,
      sku: `TST-${suffix}`,
      categoryId: category.id,
      status: ProductStatus.ACTIVE,
      publishedAt: new Date(),
      variants: {
        create: {
          sku: `TST-${suffix}-V`,
          originalPrice: opts.price ?? 100_000,
          price: opts.price ?? 100_000,
          costPrice: opts.costPrice ?? 60_000,
          isDefault: true,
          weightGrams: 300,
          inventory: { create: { quantity: opts.stock } },
        },
      },
    },
    include: { variants: true },
  });
  await refreshProductAggregates(product.id);
  return { productId: product.id, variantId: product.variants[0]!.id, sku: product.variants[0]!.sku };
}

export const checkoutBody = (addressId: string, variantId: string, quantity = 1, extra: Record<string, unknown> = {}) => ({
  addressId,
  shippingMethodCode: 'STANDARD',
  paymentMethodCode: 'MOBILE_MONEY_TEST',
  items: [{ variantId, quantity }],
  ...extra,
});

export const idem = () => ({ 'idempotency-key': `test-${randomUUID()}` });

/** Envia um webhook assinado do gateway simulado. */
export async function sendMockWebhook(app: App, payload: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify(payload);
  const mock = new MockGatewayProvider(testEnv.PAYMENT_MOCK_WEBHOOK_SECRET);
  return app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/mock',
    headers: { 'content-type': 'application/json', 'x-mock-signature': signature ?? mock.sign(body) },
    payload: body,
  });
}

export async function paymentOf(orderId: string) {
  return prisma.payment.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } });
}

/** Paga via webhook (como o gateway real faria). */
export async function payOrder(app: App, orderId: string, eventId = `evt_${randomUUID()}`) {
  const p = await paymentOf(orderId);
  return sendMockWebhook(app, { id: eventId, type: 'payment.succeeded', data: { reference: p.providerReference, amount: p.amount, currency: p.currency } });
}

export const orderIdOf = (res: CallResult) => (res.json.data.order?.id ?? res.json.data.id) as string;
