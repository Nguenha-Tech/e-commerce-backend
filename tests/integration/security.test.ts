import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers';

/** Autenticação, autorização e anti-escalada (secções 3, 57 e 64). */
describe('segurança e permissões', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('endpoints privados exigem autenticação', async () => {
    for (const url of ['/wishlist', '/notifications', '/orders', '/returns', '/users/me', '/admin/dashboard']) {
      const res = await t.call('GET', url);
      expect(res.status, url).toBe(401);
      expect(res.json.success).toBe(false);
    }
  });

  it('cliente não acede a endpoints administrativos', async () => {
    const c = await t.createCustomer();
    for (const url of ['/admin/dashboard', '/admin/orders', '/admin/coupons', '/admin/audit-logs', '/admin/settings', '/admin/whatsapp']) {
      const res = await t.call('GET', url, { token: c.token });
      expect(res.status, url).toBe(403);
      expect(res.json.errorCode).toBe('FORBIDDEN');
    }
  });

  it('ADMIN gere a loja mas não acede a finanças, auditoria, configurações nem administradores', async () => {
    const admin = await t.createStaff('ADMIN');
    expect((await t.call('GET', '/admin/orders', { token: admin.token })).status).toBe(200);
    expect((await t.call('GET', '/admin/reports/sales', { token: admin.token })).status).toBe(200);

    const dash = await t.call('GET', '/admin/dashboard', { token: admin.token });
    expect(dash.status).toBe(200);
    expect(dash.json.data.financial).toBeUndefined();

    for (const url of ['/admin/reports/revenue', '/admin/reports/payments', '/admin/audit-logs', '/admin/settings', '/admin/staff', '/admin/payment-methods', '/admin/whatsapp']) {
      expect((await t.call('GET', url, { token: admin.token })).status, url).toBe(403);
    }
  });

  it('ADMIN não consegue elevar as próprias permissões', async () => {
    const admin = await t.createStaff('ADMIN');
    const self = await t.call('PUT', `/admin/users/${admin.userId}/roles`, { token: admin.token, body: { roles: ['OWNER'] } });
    expect(self.status).toBe(403);
    const role = await t.call('POST', '/admin/roles', { token: admin.token, body: { name: 'SUPER', level: 99, permissions: ['admins:manage'] } });
    expect(role.status).toBe(403);
  });

  it('OWNER não pode alterar as próprias roles (evita ficar sem acesso)', async () => {
    const owner = await t.ownerToken();
    const me = await t.call('GET', '/users/me', { token: owner });
    const res = await t.call('PUT', `/admin/users/${me.json.data.id}/roles`, { token: owner, body: { roles: ['CUSTOMER'] } });
    expect(res.status).toBe(403);
    expect(res.json.errorCode).toBe('CANNOT_MODIFY_SELF');
  });

  it('alterações administrativas ficam na auditoria com antes/depois', async () => {
    const owner = await t.ownerToken();
    await t.call('PATCH', '/admin/settings/returns', { token: owner, body: { windowDays: 30 } });
    const logs = await t.call('GET', '/admin/audit-logs?action=settings.update', { token: owner });
    expect(logs.status).toBe(200);
    const entry = logs.json.data[0];
    expect(entry.before.windowDays).toBe(14);
    expect(entry.after.windowDays).toBe(30);
    expect(entry.requestId).toBeTruthy();
    await t.call('PATCH', '/admin/settings/returns', { token: owner, body: { windowDays: 14 } });
  });

  it('erros seguem o formato padrão', async () => {
    const res = await t.call('GET', '/products/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ success: false, errorCode: expect.any(String), message: expect.any(String), path: expect.any(String), timestamp: expect.any(String) });
  });

  it('segredos não podem ser guardados na configuração de métodos de pagamento', async () => {
    const owner = await t.ownerToken();
    const res = await t.call('POST', '/admin/payment-methods', { token: owner, body: { code: 'X_PAY', name: 'X', type: 'CARD', provider: 'mock', config: { secretKey: 'sk_live' } } });
    expect(res.status).toBe(400);
  });
});
