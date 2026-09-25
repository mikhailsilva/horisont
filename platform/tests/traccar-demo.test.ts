import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../server/db.js';
import { createTraccarDemoToken } from '../server/routes/traccar-demo.js';
import { traccarPositionToRecord } from '../server/connectors/traccar.js';
import { call } from './helpers.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'pglite:memory';
process.env.SETUP_KEY = 'test-setup-key-0123456789';

let superadmin = '';
let regularAdmin = '';
let issuedToken = '';
let baseUrl = '';
const demoPath = (suffix: string) => `${new URL(baseUrl).pathname}${suffix}`;

describe('protected synthetic Traccar demo', () => {
  beforeAll(async () => {
    const setup = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'traccar-demo-admin', password: 'secret-password' });
    expect(setup.status).toBe(201);
    superadmin = setup.data.token;

    const org = await call('POST', '/api/orgs', { kind: 'distributor', name: 'Тестовый дилер' }, superadmin);
    const invite = await call('POST', `/api/orgs/${org.data.org.id}/invites`, { role: 'admin' }, superadmin);
    const redeemed = await call('POST', '/api/auth/redeem', { code: invite.data.code, login: 'traccar-demo-user', password: 'secret-password' });
    expect(redeemed.status).toBe(201);
    regularAdmin = redeemed.data.token;
  });

  it('only issues scoped credentials to a real superadmin', async () => {
    expect((await call('POST', '/api/connectors/traccar-demo-access')).status).toBe(401);
    expect((await call('POST', '/api/connectors/traccar-demo-access', {}, regularAdmin)).status).toBe(403);
    const issued = await call('POST', '/api/connectors/traccar-demo-access', {}, superadmin);
    expect(issued.status).toBe(200);
    expect(issued.data.base_url).toBe('http://localhost/api/traccar-demo');
    expect(issued.data.expires_at).toBeTruthy();
    expect(issued.data.token).toEqual(expect.any(String));
    issuedToken = issued.data.token;
    baseUrl = issued.data.base_url;
  });

  it('does not fall back to a development key in production', () => {
    const appSecret = process.env.APP_SECRET;
    const vercel = process.env.VERCEL;
    const nodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.APP_SECRET;
      delete process.env.VERCEL;
      process.env.NODE_ENV = 'production';
      expect(() => createTraccarDemoToken('production-user')).toThrow('Demo-коннектор не настроен');

      delete process.env.NODE_ENV;
      process.env.VERCEL = '1';
      expect(() => createTraccarDemoToken('production-user')).toThrow('Demo-коннектор не настроен');
    } finally {
      if (appSecret === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = appSecret;
      if (vercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = vercel;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });

  it('requires a valid unexpired token and an active issuing account', async () => {
    expect((await call('GET', demoPath('/api/devices'))).status).toBe(401);
    expect((await call('GET', demoPath('/api/devices'), undefined, 'not-a-token')).status).toBe(401);
    const expired = createTraccarDemoToken('unused', Date.now() - 1000);
    expect((await call('GET', demoPath('/api/devices'), undefined, expired)).status).toBe(401);
    expect((await call('GET', demoPath('/api/devices'), undefined, issuedToken)).status).toBe(200);

    await (await getDb()).query(`update users set disabled = true where login = 'traccar-demo-admin'`);
  });

  it('returns three synthetic devices and bounded Traccar-format positions with convertible counters', async () => {
    const devices = await call('GET', demoPath('/api/devices'), undefined, issuedToken);
    expect(devices.status).toBe(401);

    const fresh = await call('POST', '/api/connectors/traccar-demo-access', {}, superadmin);
    expect(fresh.status).toBe(401);
    // Re-enable only for this isolated data-shape assertion; no production data is written.
    const db = await getDb();
    await db.query(`update users set disabled = false where login = 'traccar-demo-admin'`);
    const renewed = await call('POST', '/api/connectors/traccar-demo-access', {}, superadmin);
    expect(renewed.status).toBe(200);
    const token = renewed.data.token;
    const unitResponse = await call('GET', demoPath('/api/devices'), undefined, token);
    expect(unitResponse.status).toBe(200);
    expect(unitResponse.data).toHaveLength(3);
    expect(unitResponse.data.every((d: any) => d.name.startsWith('DEMO —') && d.uniqueId.startsWith('DEMO-TRACCAR-'))).toBe(true);

    const latest = await call('GET', demoPath('/api/positions'), undefined, token);
    expect(latest.status).toBe(200);
    expect(latest.data).toHaveLength(3);
    const record = traccarPositionToRecord(latest.data[0]);
    expect(record?.engine_hours_method).toBe('platform');
    expect(record?.engine_hours).toBeGreaterThan(0);
    expect(record?.odometer_km).toBeGreaterThan(0);
    expect(record?.lat).toBeGreaterThan(55);

    const history = await call('GET', `${demoPath('/api/positions')}?deviceId=101&from=2020-01-01T00%3A00%3A00.000Z&to=2099-01-01T00%3A00%3A00.000Z`, undefined, token);
    expect(history.status).toBe(200);
    expect(history.data.length).toBeLessThanOrEqual(300);
    expect(history.data.length).toBeGreaterThan(1);
    expect(history.data.every((p: any) => p.deviceId === 101 && traccarPositionToRecord(p)?.t)).toBe(true);
  });
});
