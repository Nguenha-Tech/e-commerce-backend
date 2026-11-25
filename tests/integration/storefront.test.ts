import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct, createTestApp, prisma, type TestApp } from './helpers';

/** Promoções, banners, WhatsApp e relatórios. */
describe('loja: promoções, banners, WhatsApp, relatórios', () => {
  let t: TestApp;
  let owner: string;
  beforeAll(async () => {
    t = await createTestApp();
    owner = await t.ownerToken();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('promoção por produto altera o preço do catálogo e expõe a Flash Sale', async () => {
    const p = await createProduct({ stock: 5, price: 200_000 });
    const res = await t.call('POST', '/admin/promotions', {
      token: owner,
      body: { name: 'Flash Teste', kind: 'FLASH_SALE', scope: 'PRODUCT', discountType: 'PERCENTAGE', value: 25, productIds: [p.productId], startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300)); // recálculo em background
    const product = await prisma.product.findUniqueOrThrow({ where: { id: p.productId } });
    expect(product.minPrice).toBe(150_000);
    expect(product.isOnSale).toBe(true);
    const list = await t.call('GET', '/promotions?kind=FLASH_SALE');
    expect(list.json.data.some((x: { slug: string }) => x.slug === res.json.data.slug)).toBe(true);
  });

  it('promoção exige alvo coerente com o âmbito', async () => {
    const res = await t.call('POST', '/admin/promotions', {
      token: owner,
      body: { name: 'Sem alvo', scope: 'CATEGORY', discountType: 'PERCENTAGE', value: 10, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1000).toISOString() },
    });
    expect(res.status).toBe(400);
  });

  it('banners respeitam datas e estado', async () => {
    const future = await t.call('POST', '/admin/banners', { token: owner, body: { title: 'Futuro', imageUrl: 'https://cdn.test/a.png', placement: 'PROMOTION', startsAt: new Date(Date.now() + 86_400_000).toISOString() } });
    const now = await t.call('POST', '/admin/banners', { token: owner, body: { title: 'Agora', imageUrl: 'https://cdn.test/b.png', placement: 'PROMOTION' } });
    expect(future.status).toBe(201);
    const pub = await t.call('GET', '/banners?placement=PROMOTION');
    const titles = pub.json.data.map((b: { title: string }) => b.title);
    expect(titles).toContain('Agora');
    expect(titles).not.toContain('Futuro');
    await t.call('DELETE', `/admin/banners/${now.json.data.id}`, { token: owner });
  });

  it('WhatsApp: número configurável, link contextualizado e cliques registados', async () => {
    const disabled = await t.call('POST', '/whatsapp/link', { body: { source: 'HOMEPAGE' } });
    expect(disabled.status).toBe(404);

    const bad = await t.call('PATCH', '/admin/whatsapp', { token: owner, body: { phoneNumber: '+258 84 abc' } });
    expect(bad.status).toBe(400);
    const upd = await t.call('PATCH', '/admin/whatsapp', { token: owner, body: { isEnabled: true, countryCode: '258', phoneNumber: '841234567' } });
    expect(upd.status).toBe(200);

    const p = await createProduct({ stock: 3, price: 7_500_000, name: 'Samsung Galaxy S25 Ultra' });
    const link = await t.call('POST', '/whatsapp/link', { body: { source: 'PRODUCT', productId: p.productId } });
    expect(link.status).toBe(200);
    expect(link.json.data.url).toMatch(/^https:\/\/wa\.me\/258841234567\?text=/);
    expect(link.json.data.message).toContain('Samsung Galaxy S25 Ultra');
    expect(link.json.data.message).toContain(p.sku);
    expect(link.json.data.message).toContain('75');

    const cfg = await t.call('GET', '/whatsapp/config');
    expect(cfg.json.data.enabled).toBe(true);
    expect(JSON.stringify(cfg.json.data)).not.toContain('updatedById');

    const stats = await t.call('GET', '/admin/whatsapp/analytics', { token: owner });
    expect(stats.json.data.topProducts[0].productId).toBe(p.productId);
    const audit = await t.call('GET', '/admin/audit-logs?action=whatsapp.update', { token: owner });
    expect(audit.json.data.length).toBeGreaterThan(0);
  });

  it('dashboard e relatórios respondem com totais coerentes', async () => {
    const dash = await t.call('GET', '/admin/dashboard', { token: owner });
    expect(dash.status).toBe(200);
    expect(dash.json.data.financial).toBeDefined();
    for (const period of ['day', 'week', 'month', 'year']) {
      const res = await t.call('GET', `/admin/reports/sales?period=${period}`, { token: owner });
      expect(res.status, period).toBe(200);
      const sum = res.json.data.series.reduce((s: number, r: { total: number }) => s + r.total, 0);
      expect(res.json.data.totals.total).toBe(sum);
    }
    const bad = await t.call('GET', '/admin/reports/sales?from=2026-12-01&to=2026-01-01', { token: owner });
    expect(bad.status).toBe(400);
  });
});
