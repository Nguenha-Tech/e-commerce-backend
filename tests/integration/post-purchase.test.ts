import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrderStatus, PaymentStatus, ReturnStatus } from '../../src/db/client';
import { checkoutBody, createProduct, createTestApp, idem, orderIdOf, payOrder, paymentOf, prisma, type TestApp } from './helpers';

/** Avaliações, perguntas, devoluções, reembolsos, notificações e favoritos. */
describe('pós-compra', () => {
  let t: TestApp;
  let owner: string;
  beforeAll(async () => {
    t = await createTestApp();
    owner = await t.ownerToken();
  });
  afterAll(async () => {
    await t.app.close();
  });

  async function deliveredOrder(quantity = 2) {
    const product = await createProduct({ stock: 10, price: 100_000 });
    const c = await t.createCustomer('Maria Sitoe');
    const r = await t.call('POST', '/orders', { token: c.token, headers: idem(), body: checkoutBody(c.addressId, product.variantId, quantity) });
    const orderId = orderIdOf(r);
    await payOrder(t.app, orderId);
    for (const [status, extra] of [['PROCESSING', {}], ['PACKED', {}], ['SHIPPED', { trackingCode: 'TRK-1' }], ['DELIVERED', {}]] as const) {
      const res = await t.call('PATCH', `/admin/orders/${orderId}/status`, { token: owner, body: { status, ...extra } });
      expect(res.status, status).toBe(200);
    }
    return { ...product, customer: c, orderId };
  }

  it('só quem recebeu o produto pode avaliar, uma vez', async () => {
    const product = await createProduct({ stock: 5 });
    const stranger = await t.createCustomer();
    const denied = await t.call('POST', `/products/${product.productId}/reviews`, { token: stranger.token, body: { rating: 5 } });
    expect(denied.status).toBe(403);
    expect(denied.json.errorCode).toBe('REVIEW_NOT_ALLOWED');

    const o = await deliveredOrder();
    const ok = await t.call('POST', `/products/${o.productId}/reviews`, { token: o.customer.token, body: { rating: 4, comment: 'Muito bom produto.' } });
    expect(ok.status).toBe(201);
    const dup = await t.call('POST', `/products/${o.productId}/reviews`, { token: o.customer.token, body: { rating: 1 } });
    expect(dup.status).toBe(409);

    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: o.productId } });
    expect(product2.ratingCount).toBe(1);
    expect(product2.ratingAvg).toBe(4);

    const pub = await t.call('GET', `/products/${o.productId}/reviews`);
    expect(pub.json.data[0].author).toBe('Maria S.'); // nunca o nome completo/email
    expect(pub.json.data[0].verifiedPurchase).toBe(true);
  });

  it('moderação: ocultar remove a avaliação da média', async () => {
    const o = await deliveredOrder(1);
    const rev = await t.call('POST', `/products/${o.productId}/reviews`, { token: o.customer.token, body: { rating: 2 } });
    const hide = await t.call('PATCH', `/admin/reviews/${rev.json.data.id}/status`, { token: owner, body: { status: 'HIDDEN' } });
    expect(hide.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: o.productId } })).ratingCount).toBe(0);
  });

  it('perguntas: pendentes até a loja responder', async () => {
    const product = await createProduct({ stock: 5 });
    const c = await t.createCustomer();
    const q = await t.call('POST', `/products/${product.productId}/questions`, { token: c.token, body: { question: 'Funciona com iPhone 15?' } });
    expect(q.json.data.status).toBe('PENDING');
    expect((await t.call('GET', `/products/${product.productId}/questions`)).json.data).toHaveLength(0);
    await t.call('POST', `/admin/questions/${q.json.data.id}/answer`, { token: owner, body: { answer: 'Sim.' } });
    const pub = await t.call('GET', `/products/${product.productId}/questions`);
    expect(pub.json.data[0].answer).toBe('Sim.');
    const notes = await t.call('GET', '/notifications', { token: c.token });
    expect(notes.json.data.some((n: { title: string }) => n.title.includes('respondida'))).toBe(true);
  });

  it('devolução completa: pedido → aprovação → receção (repõe stock) → reembolso', async () => {
    const o = await deliveredOrder(2);
    const detail = await t.call('GET', `/orders/${o.orderId}`, { token: o.customer.token });
    const item = detail.json.data.items[0];

    const ret = await t.call('POST', `/orders/${o.orderId}/returns`, { token: o.customer.token, body: { reason: 'Produto com defeito', items: [{ orderItemId: item.id, quantity: 1 }] } });
    expect(ret.status).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(OrderStatus.RETURN_REQUESTED);

    // Transição inválida: não se pode receber antes de aprovar.
    const early = await t.call('POST', `/admin/returns/${ret.json.data.id}/receive`, { token: owner, body: { items: [{ returnItemId: ret.json.data.items[0].id, condition: 'OK', restock: true }] } });
    expect(early.status).toBe(422);
    expect(early.json.errorCode).toBe('INVALID_RETURN_TRANSITION');

    await t.call('POST', `/admin/returns/${ret.json.data.id}/approve`, { token: owner, body: {} });
    const before = await prisma.inventory.findUniqueOrThrow({ where: { variantId: o.variantId } });
    const rcv = await t.call('POST', `/admin/returns/${ret.json.data.id}/receive`, { token: owner, body: { items: [{ returnItemId: ret.json.data.items[0].id, condition: 'Selado', restock: true }] } });
    expect(rcv.status).toBe(200);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId: o.variantId } })).quantity).toBe(before.quantity + 1);

    const refund = await t.call('POST', `/admin/returns/${ret.json.data.id}/refund`, { token: owner, body: {} });
    expect(refund.status).toBe(200);
    expect(refund.json.data.refund.amount).toBe(item.lineTotal / 2);
    expect(refund.json.data.return.status).toBe(ReturnStatus.REFUNDED);

    const payment = await paymentOf(o.orderId);
    expect(payment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(payment.refundedAmount).toBe(item.lineTotal / 2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe(OrderStatus.REFUNDED);
  });

  it('reembolso nunca excede o valor pago e é idempotente', async () => {
    const o = await deliveredOrder(1);
    const payment = await paymentOf(o.orderId);
    const key = { 'idempotency-key': `refund-${o.orderId}` };
    const tooMuch = await t.call('POST', `/admin/payments/${payment.id}/refunds`, { token: owner, headers: { 'idempotency-key': 'too-much-1' }, body: { amount: payment.amount + 1, reason: 'teste' } });
    expect(tooMuch.status).toBe(422);

    const [r1, r2] = await Promise.all([
      t.call('POST', `/admin/payments/${payment.id}/refunds`, { token: owner, headers: key, body: { amount: 10_000, reason: 'compensação' } }),
      t.call('POST', `/admin/payments/${payment.id}/refunds`, { token: owner, headers: key, body: { amount: 10_000, reason: 'compensação' } }),
    ]);
    expect(r1.json.data.id).toBe(r2.json.data.id);
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);

    const p1 = await t.call('POST', `/admin/refunds/${r1.json.data.id}/process`, { token: owner, body: {} });
    const p2 = await t.call('POST', `/admin/refunds/${r1.json.data.id}/process`, { token: owner, body: {} });
    expect(p1.json.data.status).toBe('COMPLETED');
    expect(p2.json.message).toBe('Refund was already completed');
    expect((await paymentOf(o.orderId)).refundedAmount).toBe(10_000);
  });

  it('não é possível pedir devolução fora do prazo', async () => {
    const o = await deliveredOrder(1);
    await prisma.order.update({ where: { id: o.orderId }, data: { deliveredAt: new Date(Date.now() - 60 * 86_400_000) } });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.orderId } });
    const res = await t.call('POST', `/orders/${o.orderId}/returns`, { token: o.customer.token, body: { reason: 'Já não preciso', items: [{ orderItemId: item.id, quantity: 1 }] } });
    expect(res.status).toBe(422);
    expect(res.json.errorCode).toBe('RETURN_WINDOW_EXPIRED');
  });

  it('favoritos e alerta "voltou ao stock"', async () => {
    const product = await createProduct({ stock: 0 });
    const c = await t.createCustomer();
    const add = await t.call('POST', '/wishlist/items', { token: c.token, body: { productId: product.productId, notifyWhenAvailable: true } });
    expect(add.status).toBe(201);
    expect(add.json.data[0].inStock).toBe(false);
    expect(add.json.data[0].stockAlertActive).toBe(true);

    await t.call('POST', `/admin/inventory/${product.variantId}/movements`, { token: owner, body: { type: 'PURCHASE', quantity: 5, reason: 'Compra ao fornecedor' } });
    const notes = await t.call('GET', '/notifications?type=BACK_IN_STOCK', { token: c.token });
    expect(notes.json.data).toHaveLength(1);
    const list = await t.call('GET', '/wishlist', { token: c.token });
    expect(list.json.data[0].inStock).toBe(true);
  });
});
