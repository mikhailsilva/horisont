import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../server/db.js';
import { call } from './helpers.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'pglite:memory';
process.env.SETUP_KEY = 'test-setup-key-0123456789';

let admin = '';
let dealerAdmin = '';
let otherAdmin = '';
let viewer = '';
let dispatcher = '';
const connectorId = 'connector-auth-test';

describe('connector administration', () => {
  beforeAll(async () => {
    const setup = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'fuchs-admin', password: 'secret-password' });
    expect(setup.status).toBe(201);
    admin = setup.data.token;
    const dealer = await call('POST', '/api/orgs', { kind: 'distributor', name: 'Дилер' }, admin);
    const customer = await call('POST', '/api/orgs', { kind: 'customer', parent_id: dealer.data.org.id, name: 'Заказчик' }, admin);
    const other = await call('POST', '/api/orgs', { kind: 'customer', parent_id: dealer.data.org.id, name: 'Другой клиент' }, admin);
    expect(customer.status).toBe(201);
    expect(other.status).toBe(201);
    for (const [orgId, login, save] of [
      [dealer.data.org.id, 'dealer-connectors', (token: string) => (dealerAdmin = token)],
      [other.data.org.id, 'other-connectors', (token: string) => (otherAdmin = token)],
    ] as const) {
      const invitation = await call('POST', `/api/orgs/${orgId}/invites`, { role: 'admin' }, admin);
      const redeemed = await call('POST', '/api/auth/redeem', { code: invitation.data.code, login, password: 'secret-password' });
      expect(redeemed.status).toBe(201);
      save(redeemed.data.token);
    }
    for (const role of ['viewer', 'dispatcher']) {
      const invitation = await call('POST', `/api/orgs/${customer.data.org.id}/invites`, { role }, admin);
      const redeemed = await call('POST', '/api/auth/redeem', {
        code: invitation.data.code,
        login: `${role}-connectors`,
        password: 'secret-password',
      });
      expect(redeemed.status).toBe(201);
      if (role === 'viewer') viewer = redeemed.data.token;
      else dispatcher = redeemed.data.token;
    }
    await (await getDb()).query(
      `insert into connectors (id, org_id, kind, label, base_url, secret_enc) values ($1, $2, $3, $4, $5, $6)`,
      [connectorId, customer.data.org.id, 'wialon', 'Подключение', 'https://wialon.example', 'invalid-secret'],
    );
  });

  it('read-only and machine operators cannot synchronize a platform or request its login link', async () => {
    for (const token of [viewer, dispatcher]) {
      expect((await call('POST', `/api/connectors/${connectorId}/sync`, {}, token)).status).toBe(403);
      expect((await call('POST', '/api/refresh', {}, token)).status).toBe(403);
      expect((await call('GET', '/api/connectors/wialon/login-url', undefined, token)).status).toBe(403);
    }
  });

  it('only generates HTTPS Wialon links returning to this cabinet', async () => {
    const invalid = await call('GET', '/api/connectors/wialon/login-url?host=http%3A%2F%2Fexample.org', undefined, admin);
    expect(invalid.status).toBe(400);
    const redirect = await call('GET', '/api/connectors/wialon/login-url?redirect=https%3A%2F%2Fexample.org', undefined, admin);
    expect(redirect.status).toBe(400);
    const safe = await call('GET', '/api/connectors/wialon/login-url?host=https%3A%2F%2Fwialon.integrator.example', undefined, admin);
    expect(safe.status).toBe(200);
    const url = new URL(safe.data.url);
    expect(url.origin).toBe('https://wialon.integrator.example');
    expect(url.pathname).toBe('/login.html');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/app/#/connect/wialon');
  });

  it('keeps connectors inside an organisation tree and lets its distributor administer them', async () => {
    expect((await call('GET', '/api/connectors', undefined, otherAdmin)).data.connectors).toHaveLength(0);
    expect((await call('POST', `/api/connectors/${connectorId}/sync`, {}, otherAdmin)).status).toBe(404);
    expect((await call('DELETE', `/api/connectors/${connectorId}`, undefined, otherAdmin)).status).toBe(404);
    expect((await call('GET', '/api/connectors', undefined, dealerAdmin)).data.connectors).toHaveLength(1);
    expect((await call('DELETE', `/api/connectors/${connectorId}`, undefined, dealerAdmin)).status).toBe(200);
  });
});
