import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { handle } from '../server/app.js';
import { getDb } from '../server/db.js';
import { encryptSecret } from '../server/secrets.js';
import { fetchUnits, syncConnector } from '../server/connectors/sync.js';
import {
  autographApiBase,
  autographHours,
  autographOnlineToRecords,
  autographStamp,
  autographTrackToRecords,
} from '../server/connectors/autograph.js';
import vectors from './data/autograph_demo_vectors.json';
import { call } from './helpers.js';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'pglite:memory';
process.env.SETUP_KEY = 'test-setup-key-0123456789';

// Route the connector's HTTP calls to the in-process API (the synthetic АвтоГРАФ.WEB emulator lives there).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(String(input), init))) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

let superadmin = '';
let customerId = '';
let access: { base_url: string; username: string; password: string } = { base_url: '', username: '', password: '' };

describe('АвтоГРАФ.WEB connector', () => {
  beforeAll(async () => {
    const setup = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'autograph-admin', password: 'secret-password' });
    expect(setup.status).toBe(201);
    superadmin = setup.data.token;
    const org = await call('POST', '/api/orgs', { kind: 'customer', name: 'Агрохолдинг (не демо)' }, superadmin);
    customerId = org.data.org.id;
    const issued = await call('POST', '/api/connectors/autograph-demo-access', {}, superadmin);
    expect(issued.status).toBe(200);
    access = issued.data;
  });

  it('parses .NET TimeSpan hours, request stamps and the API base', () => {
    expect(autographHours('16:00:00')).toBe(16);
    expect(autographHours('130.02:30:00')).toBeCloseTo(130 * 24 + 2.5, 6);
    expect(autographHours('4731.17:46:56.1127490')).toBeCloseTo(4731 * 24 + 17 + 46 / 60 + 56 / 3600, 6);
    expect(autographHours(12.5)).toBe(12.5);
    expect(autographHours('n/a')).toBeNull();
    expect(autographStamp(new Date(Date.UTC(2013, 9, 11, 10, 5, 7)))).toBe('20131011-100507');
    expect(autographApiBase('https://demo.tk-nav.com/')).toBe('https://demo.tk-nav.com/ServiceJSON');
    expect(autographApiBase('https://demo.tk-nav.com/ServiceJSON')).toBe('https://demo.tk-nav.com/ServiceJSON');
  });

  it('decodes responses captured from the vendor public demo server', () => {
    const online = Object.values(vectors.online as Record<string, any>).filter(Boolean);
    const first = online.find((o) => o.Name === 'John Deere 1');
    const recs = autographOnlineToRecords(first);
    expect(recs[0]).toMatchObject({ t: '2013-10-11T17:36:42.000Z', lat: 52.17369, lon: 34.12502833 });
    expect(recs[0].speed_kmh).toBeCloseTo(8.83, 2);
    const track = autographTrackToRecords(Object.values(vectors.track as Record<string, unknown>)[0]);
    expect(track.length).toBe(13);
    expect(track.every((r) => r.lat! > 52 && r.lon! > 34 && typeof r.speed_kmh === 'number')).toBe(true);
  });

  it('emulator mirrors the real server: 401 on bad login, 429 above 10 objects', async () => {
    const api = `${access.base_url}/ServiceJSON`;
    const bad = await handle(new Request(`${api}/Login`, { method: 'POST', body: new URLSearchParams({ UserName: 'itles-demo', Password: 'wrong' }) }));
    expect(bad.status).toBe(401);
    const ok = await handle(new Request(`${api}/Login`, { method: 'POST', body: new URLSearchParams({ UserName: access.username, Password: access.password }) }));
    const token = await ok.text();
    const ids = Array.from({ length: 11 }, (_, i) => `x${i}`).join(',');
    const many = await handle(new Request(`${api}/GetOnlineInfo?schemaID=itles-demo-schema&IDs=${ids}`, { headers: { 'AG-Token': token } }));
    expect(many.status).toBe(429);
    expect((await handle(new Request(`${api}/EnumSchemas`))).status).toBe(401);
  });

  it('reads three machines with track, CAN engine hours and sensors', async () => {
    const units = await fetchUnits('autograph', access.base_url, { username: access.username, password: access.password }, new Date(Date.now() - 3 * 3600e3));
    expect(units.map((u) => u.name)).toEqual([
      'DEMO — Кировец К-742М · АвтоГРАФ-SX (CAN)',
      'DEMO — John Deere 8R 410 · АвтоГРАФ-GX (CAN)',
      'DEMO — МТЗ-82.1 · АвтоГРАФ-SL + ДУТ (без CAN)',
    ]);
    for (const u of units) {
      expect(u.id).toMatch(/^itles-demo-schema:demo-/);
      expect(u.records.filter((r) => r.lat != null).length).toBeGreaterThan(30);
      const counters = u.records.find((r) => r.engine_hours != null)!;
      expect(counters.engine_hours_method).toBe('platform');
      expect(counters.engine_hours).toBeGreaterThan(1000);
      expect(counters.sensors?.fuel_level_l).toBeGreaterThan(0);
    }
    expect(units[0].records.some((r) => r.sensors?.rpm && r.sensors?.coolant_temp_c)).toBe(true);
    expect(units[2].records.some((r) => r.sensors?.rpm)).toBe(false);
  });

  it('dry-run check works, while synthetic and vendor demo data never go into a real customer', async () => {
    const test = await call('POST', '/api/connectors/test', { kind: 'autograph', org_id: customerId, ...access }, superadmin);
    expect(test.status).toBe(200);
    expect(test.data.units).toBe(3);
    const synthetic = await call('POST', '/api/connectors', { kind: 'autograph', org_id: customerId, ...access }, superadmin);
    expect(synthetic.status).toBe(400);
    expect(synthetic.data.error).toBe('demo_only');
    const vendor = await call('POST', '/api/connectors', { kind: 'autograph', org_id: customerId, base_url: 'https://demo.tk-nav.com', username: 'demo', password: 'demo' }, superadmin);
    expect(vendor.status).toBe(400);
    expect(vendor.data.error).toBe('demo_only');
  });

  it('sync stores positions and engine hours through the regular ingest path', async () => {
    const db = await getDb();
    const id = randomUUID();
    const secret = encryptSecret(JSON.stringify({ username: access.username, password: access.password }));
    await db.query(`insert into connectors (id, org_id, kind, label, base_url, secret_enc) values ($1, $2, 'autograph', 'АвтоГРАФ тест', $3, $4)`, [
      id,
      customerId,
      access.base_url,
      secret,
    ]);
    const report = await syncConnector(db, id, { historyHours: 2 });
    expect(report.units).toBe(3);
    expect(report.new_machines).toBe(3);
    expect(report.result.positions).toBeGreaterThan(60);
    expect(report.result.counters).toBeGreaterThanOrEqual(3);
    expect(report.result.rejected).toEqual([]);
    const again = await syncConnector(db, id, { historyHours: 2 });
    expect(again.new_machines).toBe(0);
  });
});
