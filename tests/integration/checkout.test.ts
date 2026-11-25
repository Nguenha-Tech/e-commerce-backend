import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscountType, OrderStatus, PaymentStatus } from '../../src/db/client';
import { PaymentsService } from '../../src/modules/orders/payments/payments.service';
import { checkoutBody, createProduct, createTestApp, idem, orderIdOf, payOrder, paymentOf, prisma, sendMockWebhook, type TestApp } from './helpers';

/** Cenários críticos da secção 57: concorrência, idempotência, cupões, stock, webhooks. */
describe('checkout, stock e pagamentos', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('compra simultânea: com stock 1 só um de dois clientes consegue comprar', async () => {
    const { variantId } = await createProduct({ stock: 1 });
    const [a, b] = await Promise.all([t.createCustomer('Cliente A'), t.createCustomer('Cliente B')]);

    const results = await Promise.all([
      t.call('POST', '/orders', { token: a.token, headers: idem(), body: checkoutBody(a.addressId, variantId) }),
      t.call('POST', '/orders', { token: b.token, headers: idem(), body: checkoutBody(b.addressId, variantId) }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.json.errorCode).toBe('INSUFFICIENT_STOCK');

    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
    expect(inv.reserved).toBe(1);
    expect(inv.quantity - inv.reserved).toBe(0);
  });

  it('dez compras simultâneas com stock 3 vendem exatamente 3', async () => {
    const { variantId } = await createProduct({ stock: 3 });
    const customers = await Promise.all(Array.from({ length: 10 }, (_, i) => t.createCustomer(`Cliente ${i}`)));
    const results = await Promise.all(customers.map((c) => t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId) })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
    expect(inv.reserved).toBe(3);
  });

  it('stock insuficiente: rejeita quantidade acima do disponível', async () => {
    const { variantId } = await createProduct({ stock: 2 });
    const c = await t.createCustomer();
    const res = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId, 3) });
    expect([409, 422]).toContain(res.status);
    expect(await prisma.order.count({ where: { userId: c.userId } })).toBe(0);
  });

  it('pedido duplicado: a mesma Idempotency-Key devolve o mesmo pedido', async () => {
    const { variantId } = await createProduct({ stock: 10 });
    const c = await t.createCustomer();
    const headers = idem();
    const [r1, r2] = await Promise.all([
      t.call('POST', '/orders', { token: c.token, headers, body: checkoutBody(c.addressId, variantId) }),
      t.call('POST', '/orders', { token: c.token, headers, body: checkoutBody(c.addressId, variantId) }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(orderIdOf(r1)).toBe(orderIdOf(r2));
    expect(await prisma.order.count({ where: { userId: c.userId } })).toBe(1);
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
    expect(inv.reserved).toBe(1);
  });

  it('cupão expirado é rejeitado', async () => {
    const { variantId } = await createProduct({ stock: 5 });
    await prisma.coupon.create({ data: { code: 'OLD2025', discountType: DiscountType.PERCENTAGE, value: 10, expiresAt: new Date(Date.now() - 86_400_000) } });
    const c = await t.createCustomer();
    const res = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId, 1, { couponCode: 'OLD2025' }) });
    expect(res.status).toBe(422);
    expect(res.json.errorCode).toBe('COUPON_EXPIRED');
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
    expect(inv.reserved).toBe(0); // nada ficou reservado
  });

  it('cupão com limite de 1 por cliente não pode ser usado duas vezes', async () => {
    const { variantId } = await createProduct({ stock: 5 });
    await prisma.coupon.create({ data: { code: 'ONCE10', discountType: DiscountType.PERCENTAGE, value: 10, usageLimitPerUser: 1 } });
    const c = await t.createCustomer();
    const r1 = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId, 1, { couponCode: 'ONCE10' }) });
    expect(r1.status).toBe(201);
    expect(r1.json.data.order.totals.couponDiscount).toBeGreaterThan(0);
    const r2 = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId, 1, { couponCode: 'ONCE10' }) });
    expect(r2.status).toBe(422);
    expect(r2.json.errorCode).toBe('COUPON_USER_LIMIT_REACHED');
  });

  it('o preço guardado no pedido não muda quando o produto muda de preço', async () => {
    const { variantId } = await createProduct({ stock: 5, price: 200_000 });
    const c = await t.createCustomer();
    const r = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId) });
    await prisma.productVariant.update({ where: { id: variantId }, data: { price: 999_999, originalPrice: 999_999 } });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: orderIdOf(r) } });
    expect(item.unitPrice).toBe(200_000);
  });

  it('webhook duplicado é processado uma única vez', async () => {
    const { variantId } = await createProduct({ stock: 5 });
    const c = await t.createCustomer();
    const r = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId, 2) });
    const orderId = orderIdOf(r);

    const [w1, w2] = await Promise.all([payOrder(t.app, orderId, 'evt_dup_1'), payOrder(t.app, orderId, 'evt_dup_1')]);
    expect(w1.statusCode).toBe(200);
    expect(w2.statusCode).toBe(200);
    expect([w1.json().data.duplicate, w2.json().data.duplicate].sort()).toEqual([false, true]);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });
    expect(inv.quantity).toBe(3); // saída de stock aplicada uma única vez
    expect(inv.reserved).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { referenceId: orderId } })).toBe(1);
  });

  it('pagamento duplicado (eventos diferentes para o mesmo pagamento) não confirma duas vezes', async () => {
    const { variantId } = await createProduct({ stock: 5 });
    const c = await t.createCustomer();
    const r = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId) });
    const orderId = orderIdOf(r);
    await Promise.all([payOrder(t.app, orderId, 'evt_a'), payOrder(t.app, orderId, 'evt_b')]);
    const again = await new PaymentsService().markPaid((await paymentOf(orderId)).id, { source: 'MANUAL' });
    expect(again.alreadyPaid).toBe(true);

    const p = await paymentOf(orderId);
    expect(p.status).toBe(PaymentStatus.PAID);
    expect(await prisma.paymentTransaction.count({ where: { paymentId: p.id, status: PaymentStatus.PAID } })).toBe(1);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId } })).quantity).toBe(4);
  });

  it('webhook com assinatura inválida é recusado', async () => {
    const res = await sendMockWebhook(t.app, { id: 'evt_x', type: 'payment.succeeded', data: { reference: 'x' } }, 'deadbeef');
    expect(res.statusCode).toBe(401);
    expect(res.json().errorCode).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('webhook com valor divergente não confirma o pedido', async () => {
    const { variantId } = await createProduct({ stock: 5 });
    const c = await t.createCustomer();
    const r = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId) });
    const p = await paymentOf(orderIdOf(r));
    const res = await sendMockWebhook(t.app, { id: 'evt_wrong_amount', type: 'payment.succeeded', data: { reference: p.providerReference, amount: 1, currency: p.currency } });
    expect(res.statusCode).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderIdOf(r) } })).status).toBe(OrderStatus.PENDING);
  });

  it('o total é calculado no servidor (expectedTotal divergente é recusado)', async () => {
    const { variantId } = await createProduct({ stock: 5, price: 150_000 });
    const c = await t.createCustomer();
    const res = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, variantId, 1, { expectedTotal: 1 }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.order.count({ where: { userId: c.userId } })).toBe(0);
  });
});
