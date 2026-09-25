import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../server/db.js';
import { encryptSecret } from '../server/secrets.js';
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
    const local = await call('GET', '/api/connectors/wialon/login-url?host=https%3A%2F%2Fwialon.integrator.example%2Ffleet%2F', undefined, admin);
    expect(local.status).toBe(200);
    expect(new URL(local.data.url).pathname).toBe('/fleet/login.html');
  });

  it('tests Traccar without saving credentials or importing devices', async () => {
    const db = await getDb();
    const before = await db.query(
      `select (select count(*)::int from connectors) connectors,
              (select count(*)::int from machines) machines,
              (select count(*)::int from sources) sources,
              (select count(*)::int from audit_log) audits`,
    );
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toMatch(/^https:\/\/traccar\.example\.org\/api\/(devices|positions)$/);
      const data = String(url).endsWith('/devices')
        ? Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Техника ${i + 1}` }))
        : [];
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    });
    try {
      const result = await call(
        'POST',
        '/api/connectors/test',
        { base_url: 'https://traccar.example.org/api/', token: 'never-return-this-token', org_id: (await db.query<any>(`select org_id from connectors where id = $1`, [connectorId])).rows[0].org_id },
        dealerAdmin,
      );
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ units: 7, devices: ['Техника 1', 'Техника 2', 'Техника 3', 'Техника 4', 'Техника 5'] });
      expect(JSON.stringify(result.data)).not.toContain('never-return-this-token');
      expect(fetchStub).toHaveBeenCalledTimes(2);
      const after = await db.query(
        `select (select count(*)::int from connectors) connectors,
                (select count(*)::int from machines) machines,
                (select count(*)::int from sources) sources,
                (select count(*)::int from audit_log) audits`,
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('rejects Traccar dry-runs for unauthorized roles and organisations', async () => {
    const db = await getDb();
    const orgId = (await db.query<any>(`select org_id from connectors where id = $1`, [connectorId])).rows[0].org_id;
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { headers: { 'content-type': 'application/json' } }));
    try {
      const body = { base_url: 'https://traccar.example.org', token: 'secret', org_id: orgId };
      expect((await call('POST', '/api/connectors/test', body, viewer)).status).toBe(403);
      expect((await call('POST', '/api/connectors/test', body, otherAdmin)).status).toBe(404);
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('rejects synthetic imports into a real customer before fetching or saving', async () => {
    const db = await getDb();
    const orgId = (await db.query<any>(`select org_id from connectors where id = $1`, [connectorId])).rows[0].org_id;
    const fetchStub = vi.spyOn(globalThis, 'fetch');
    try {
      const r = await call('POST', '/api/connectors', { kind: 'traccar', base_url: 'https://itles.example/api/traccar-demo', token: 'scoped-demo-token', org_id: orgId }, dealerAdmin);
      expect(r.status).toBe(400);
      expect(r.data.error).toBe('demo_only');
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      fetchStub.mockRestore();
    }
  });

  it('keeps connectors inside an organisation tree and lets its distributor administer them', async () => {
    expect((await call('GET', '/api/connectors', undefined, otherAdmin)).data.connectors).toHaveLength(0);
    expect((await call('POST', `/api/connectors/${connectorId}/sync`, {}, otherAdmin)).status).toBe(404);
    expect((await call('DELETE', `/api/connectors/${connectorId}`, undefined, otherAdmin)).status).toBe(404);
    expect((await call('GET', '/api/connectors', undefined, dealerAdmin)).data.connectors).toHaveLength(1);
    await (await getDb()).query(
      `update connectors set kind = 'traccar', base_url = 'https://traccar.example', secret_enc = $2 where id = $1`,
      [connectorId, encryptSecret(JSON.stringify({ token: 'test-token' }))],
    );
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toMatch(/^https:\/\/traccar\.example\/api\/(devices|positions)$/);
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    });
    try {
      const sync = await call('POST', `/api/connectors/${connectorId}/sync`, {}, dealerAdmin);
      expect(sync.status).toBe(200);
      expect(sync.data.report.units).toBe(0);
      expect(fetchStub).toHaveBeenCalledTimes(2);
    } finally {
      fetchStub.mockRestore();
    }
    expect((await call('DELETE', `/api/connectors/${connectorId}`, undefined, dealerAdmin)).status).toBe(200);
  });
});
