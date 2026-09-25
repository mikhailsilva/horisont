import type { IngestRecord } from '../ingest.js';
import { ConnectorError, fetchJson, trimBase, type RemoteUnit } from './types.js';

/**
 * АвтоГРАФ.WEB / AutoGRAPH.NET Service JSON API (ТехноКом), https://docs.tk-nav.ru/web/docs/development/API/api.
 * Contract checked against the public server https://demo.tk-nav.com (2026-09-25): POST Login returns a plain-text
 * token, later calls send it as the AG-Token header and require schemaID; GetOnlineInfo/GetTrack accept at most
 * 10 objects per request (HTTP 429 otherwise). Speeds are km/h. Engine hours and odometer are schema parameters,
 * so they are only read when the schema exposes them in the online panel ("Final").
 */
export interface AutographConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  token?: string;
}

const CHUNK = 10;

export function autographApiBase(baseUrl: string): string {
  return trimBase(baseUrl).replace(/\/ServiceJSON$/i, '') + '/ServiceJSON';
}

/** .NET TimeSpan ("d.hh:mm:ss[.fffffff]" or "hh:mm:ss") or plain number → hours. */
export function autographHours(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^(-)?(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[2] ?? 0) * 24 + Number(m[3]) + Number(m[4]) / 60 + Number(m[5]) / 3600;
  return m[1] ? -h : h;
}

/** AvtoGRAF timestamps: "…Z" when present, otherwise UTC because we log in with UTCOffset=0. */
export function autographTime(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const iso = /Z|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z';
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}

export function autographStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const HOURS_KEYS = /^(motohours(bycanemh)?|enginehours|enginemotohours(total)?|canemh|mh)$/i;
const ODO_KEYS = /^(odometer|mileage(bycan)?|totalmileage|candist|candistance)$/i;
const SENSOR_KEYS: Array<[RegExp, string]> = [
  [/^(fuellevel|tankfuellevel|canl1)$/i, 'fuel_level_l'],
  [/^(rotation|rpm|canerpm)$/i, 'rpm'],
  [/^(coolanttemper|сoolanttemper|cantcool)$/i, 'coolant_temp_c'],
  [/^(oilpressure)$/i, 'oil_pressure_kpa'],
  [/^(engineload|caneload)$/i, 'engine_load_pct'],
  [/^(consumption|canfcalc)$/i, 'fuel_used_l'],
];

export function autographOnlineToRecords(o: any): IngestRecord[] {
  if (!o || typeof o !== 'object') return [];
  const out: IngestRecord[] = [];
  const pos = o.LastPosition;
  const tPos = autographTime(o._LastCoords ?? o.LastCoords);
  if (tPos && pos && typeof pos.Lat === 'number' && typeof pos.Lng === 'number' && !(pos.Lat === 0 && pos.Lng === 0)) {
    const rec: IngestRecord = { t: tPos, lat: pos.Lat, lon: pos.Lng };
    if (typeof o.Speed === 'number') rec.speed_kmh = o.Speed;
    if (typeof o.Course === 'number') rec.course = o.Course;
    out.push(rec);
  }
  const tData = autographTime(o._LastData ?? o.LastData ?? o.DT);
  const final = o.Final && typeof o.Final === 'object' ? o.Final : {};
  if (tData) {
    const rec: IngestRecord = { t: tData };
    const sensors: Record<string, number> = {};
    for (const [k, v] of Object.entries(final)) {
      if (HOURS_KEYS.test(k)) {
        const h = autographHours(v);
        if (h !== null && h > 0) {
          rec.engine_hours = h;
          rec.engine_hours_method = 'platform';
        }
      } else if (ODO_KEYS.test(k) && typeof v === 'number' && v > 0) {
        rec.odometer_km = v;
        rec.odometer_method = 'platform';
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        const hit = SENSOR_KEYS.find(([re]) => re.test(k));
        if (hit) sensors[hit[1]] = v;
      }
    }
    if (Object.keys(sensors).length) rec.sensors = sensors;
    if (rec.engine_hours != null || rec.odometer_km != null || rec.sensors) out.push(rec);
  }
  return out;
}

/** GetTrack returns, per object, segments of parallel arrays DT/Lat/Lng/Speed. */
export function autographTrackToRecords(segments: unknown): IngestRecord[] {
  const out: IngestRecord[] = [];
  for (const s of Array.isArray(segments) ? segments : []) {
    const dt: unknown[] = Array.isArray(s?.DT) ? s.DT : [];
    for (let i = 0; i < dt.length; i++) {
      const t = autographTime(dt[i]);
      const lat = s.Lat?.[i];
      const lon = s.Lng?.[i];
      if (!t || typeof lat !== 'number' || typeof lon !== 'number') continue;
      const rec: IngestRecord = { t, lat, lon };
      if (typeof s.Speed?.[i] === 'number') rec.speed_kmh = s.Speed[i];
      out.push(rec);
    }
  }
  return out;
}

async function login(api: string, cfg: AutographConfig): Promise<string> {
  if (cfg.token) return cfg.token;
  if (!cfg.username || !cfg.password) throw new ConnectorError('config', 'Укажите логин и пароль пользователя АвтоГРАФ.WEB с правом «Доступ через API»');
  const token = await fetchJson(`${api}/Login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ UserName: cfg.username, Password: cfg.password, UTCOffset: '0' }).toString(),
  });
  if (typeof token !== 'string' || !/^[0-9A-Za-z._-]{16,}$/.test(token.trim()))
    throw new ConnectorError('auth', 'АвтоГРАФ.WEB не выдал токен: проверьте логин, пароль и право «Доступ через API»');
  return token.trim();
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function autographUnits(cfg: AutographConfig, historyFrom?: Date): Promise<RemoteUnit[]> {
  const api = autographApiBase(cfg.baseUrl);
  const token = await login(api, cfg);
  const h = { 'AG-Token': token, accept: 'application/json' };
  const get = (method: string, q: Record<string, string>, timeoutMs?: number) =>
    fetchJson(`${api}/${method}?${new URLSearchParams(q)}`, { headers: h, timeoutMs });

  const schemas = await get('EnumSchemas', {});
  if (!Array.isArray(schemas)) throw new ConnectorError('format', 'Ответ АвтоГРАФ.WEB EnumSchemas не является списком');
  const units: RemoteUnit[] = [];
  for (const schema of schemas) {
    if (!schema?.ID || schema.State === false) continue;
    const tree = await get('EnumDevices', { schemaID: schema.ID });
    const items: any[] = (Array.isArray(tree?.Items) ? tree.Items : []).filter((d: any) => d?.ID && d.Allowed !== false);
    const byId = new Map<string, RemoteUnit>();
    for (const d of items) {
      const props: any[] = Array.isArray(d.Properties) ? d.Properties : [];
      const reg = props.find((p) => p?.Name === 'VehicleRegNumber')?.Value;
      const unit: RemoteUnit = {
        id: `${schema.ID}:${d.ID}`,
        name: String(d.Name ?? `АвтоГРАФ ${d.Serial ?? d.ID}`),
        model: typeof reg === 'string' && reg ? `госномер ${reg}` : d.Serial ? `АвтоГРАФ № ${d.Serial}` : null,
        records: [],
      };
      byId.set(String(d.ID), unit);
      units.push(unit);
    }
    for (const ids of chunks([...byId.keys()], CHUNK)) {
      const q = { schemaID: schema.ID, IDs: ids.join(',') };
      if (historyFrom) {
        const track = await get('GetTrack', { ...q, SD: autographStamp(historyFrom), ED: autographStamp(new Date()), tripSplitterIndex: '-1' }, 60_000);
        for (const id of ids) byId.get(id)!.records.push(...autographTrackToRecords(track?.[id]));
      }
      const online = await get('GetOnlineInfo', q);
      for (const id of ids) byId.get(id)!.records.push(...autographOnlineToRecords(online?.[id]));
    }
  }
  return units;
}
