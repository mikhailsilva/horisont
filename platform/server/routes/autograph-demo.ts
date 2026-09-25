// Synthetic АвтоГРАФ.WEB (ServiceJSON) emulator for the personal connector test. It implements only the calls
// used by connectors/autograph.ts and mirrors the real server's behaviour (plain-text Login token, AG-Token header,
// HTTP 401 on bad credentials, HTTP 429 above 10 objects). Machines and readings are generated, not field data.
import { HttpError, json } from '../http.js';
import { router, type Ctx } from '../core.js';
import { assertDemoIssuer, assertDemoToken, createTraccarDemoToken } from './traccar-demo.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT_MS = 48 * 60 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;
const SCHEMA = { ID: 'itles-demo-schema', Name: 'ITles · личный тест АвтоГРАФ', Group: '', GroupID: '', State: true };
export const DEMO_LOGIN = 'itles-demo';

// Same three machines as the АвтоГРАФ guide (docs/guide/autograph-technokom.md): CAN tractor, CAN tractor with OEM
// telematics, and a mechanical tractor where hours come from the ignition input and fuel from a level sensor.
export const AUTOGRAPH_DEMO_UNITS = [
  { id: 'demo-k742', serial: 3400101, name: 'DEMO — Кировец К-742М · АвтоГРАФ-SX (CAN)', reg: '23 КК 7421', lat: 45.3102, lon: 39.1105, can: true, hours0: 3120, lph: 38 },
  { id: 'demo-jd8r', serial: 3400102, name: 'DEMO — John Deere 8R 410 · АвтоГРАФ-GX (CAN)', reg: '23 КК 8410', lat: 45.2795, lon: 39.0561, can: true, hours0: 1875, lph: 45 },
  { id: 'demo-mtz82', serial: 3400103, name: 'DEMO — МТЗ-82.1 · АвтоГРАФ-SL + ДУТ (без CAN)', reg: '23 КК 0821', lat: 45.3344, lon: 39.1712, can: false, hours0: 9640, lph: 9 },
] as const;
type Unit = (typeof AUTOGRAPH_DEMO_UNITS)[number];
const anchorMs = Date.UTC(2026, 0, 1);
const WORK_SHARE = 0.55;
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const timeSpan = (hours: number) => {
  const total = Math.floor(hours * 3600);
  const d = Math.floor(total / 86400);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d}.${p(Math.floor((total % 86400) / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
};
const round = (v: number, k = 10) => Math.round(v * k) / k;

function sample(u: Unit, at: number) {
  const n = AUTOGRAPH_DEMO_UNITS.indexOf(u);
  const phase = at / (1000 * 60 * 60 * 2) + n * 2.1;
  const hours = u.hours0 + (Math.max(0, at - anchorMs) / 3_600_000) * WORK_SHARE;
  const working = Math.sin(phase) > -0.3;
  const tank = 700 - (((at / 3_600_000) * u.lph) % 500);
  return {
    lat: u.lat + Math.sin(phase) * 0.004,
    lon: u.lon + Math.cos(phase * 0.9) * 0.006,
    speed: working ? round(7 + Math.abs(Math.sin(phase * 3)) * 5) : 0,
    course: round((((phase * 40) % 360) + 360) % 360),
    hours,
    fuel: round(u.can ? tank : tank * 0.25),
    rpm: working ? Math.round(1500 + Math.sin(phase * 5) * 250) : 800,
    coolant: working ? round(86 + Math.sin(phase * 2) * 4) : 70,
    consumption: round((hours - u.hours0) * u.lph),
  };
}

const stamp = (v: string | null): number => {
  const m = v && /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/.exec(v);
  if (!m) throw new HttpError(400, 'bad_range', 'SD/ED: формат yyyyMMdd-HHmmss');
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};

async function authorized(c: Ctx): Promise<void> {
  const token = c.req.headers.get('ag-token') ?? c.url.searchParams.get('session') ?? '';
  try {
    await assertDemoToken(c, token);
  } catch {
    throw new HttpError(401, 'unauthorized', 'Недействительный или истёкший demo-токен');
  }
}

function selected(c: Ctx): Unit[] {
  if (c.url.searchParams.get('schemaID') !== SCHEMA.ID) throw new HttpError(400, 'bad_schema', 'Неизвестная схема');
  const ids = (c.url.searchParams.get('IDs') ?? '').split(',').filter(Boolean);
  if (ids.length > 10)
    throw new HttpError(429, 'too_many', `В запросе ${ids.length} объектов мониторинга, количество в одном запросе не должно превышать 10.`);
  return AUTOGRAPH_DEMO_UNITS.filter((u) => ids.includes(u.id));
}

router.on('POST', '/api/connectors/autograph-demo-access', async (c) => {
  const userId = await assertDemoIssuer(c);
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  return json({
    base_url: `${c.url.origin}/api/autograph-demo`,
    username: DEMO_LOGIN,
    password: createTraccarDemoToken(userId, expiresAt),
    expires_at: new Date(expiresAt).toISOString(),
  });
});

router.on('POST', '/api/autograph-demo/ServiceJSON/Login', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const password = form.get('Password') ?? '';
  if (form.get('UserName') !== DEMO_LOGIN) return new Response('', { status: 401 });
  try {
    await assertDemoToken(c, password);
  } catch {
    return new Response('', { status: 401 });
  }
  return new Response(password, { headers: { 'content-type': 'text/plain' } });
});

router.on('GET', '/api/autograph-demo/ServiceJSON/EnumSchemas', async (c) => {
  await authorized(c);
  return json([SCHEMA]);
});

router.on('GET', '/api/autograph-demo/ServiceJSON/EnumDevices', async (c) => {
  await authorized(c);
  if (c.url.searchParams.get('schemaID') !== SCHEMA.ID) throw new HttpError(400, 'bad_schema', 'Неизвестная схема');
  return json({
    ID: SCHEMA.ID,
    Groups: [{ ID: 'demo-group', ParentID: null, Name: 'Поле 12 · синтетика' }],
    Items: AUTOGRAPH_DEMO_UNITS.map((u) => ({
      ID: u.id,
      ParentID: 'demo-group',
      Name: u.name,
      Serial: u.serial,
      Allowed: true,
      Properties: [{ Inherited: false, Type: 0, Name: 'VehicleRegNumber', Value: u.reg }],
    })),
  });
});

router.on('GET', '/api/autograph-demo/ServiceJSON/GetOnlineInfo', async (c) => {
  await authorized(c);
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const out: Record<string, unknown> = {};
  for (const u of selected(c)) {
    const s = sample(u, now);
    const final: Record<string, unknown> = { MotohoursByCANEmh: timeSpan(s.hours), FuelLevel: s.fuel, Speed: s.speed };
    if (u.can) Object.assign(final, { Rotation: s.rpm, СoolantTemper: s.coolant, Consumption: s.consumption });
    out[u.id] = {
      ID: u.id,
      Name: u.name,
      _LastCoords: iso(now),
      _LastData: iso(now),
      DT: iso(now),
      LastPosition: { Lat: s.lat, Lng: s.lon },
      Speed: s.speed,
      Course: s.course,
      State: 1,
      Final: final,
    };
  }
  return json(out);
});

router.on('GET', '/api/autograph-demo/ServiceJSON/GetTrack', async (c) => {
  await authorized(c);
  const now = Date.now();
  const from = Math.max(stamp(c.url.searchParams.get('SD')), now - HISTORY_LIMIT_MS);
  const to = Math.min(stamp(c.url.searchParams.get('ED')), now);
  const out: Record<string, unknown> = {};
  for (const u of selected(c)) {
    const DT: string[] = [];
    const Lat: number[] = [];
    const Lng: number[] = [];
    const Speed: number[] = [];
    for (let t = Math.ceil(from / STEP_MS) * STEP_MS; t <= to; t += STEP_MS) {
      const s = sample(u, t);
      DT.push(iso(t));
      Lat.push(s.lat);
      Lng.push(s.lon);
      Speed.push(s.speed);
    }
    out[u.id] = DT.length ? [{ Index: 0, DT, Lat, Lng, Speed }] : [];
  }
  return json(out);
});
