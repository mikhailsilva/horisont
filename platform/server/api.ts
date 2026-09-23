import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import {
  hashPassword,
  newInviteCode,
  newPairingCode,
  newToken,
  normalizeCode,
  sha256,
  validLogin,
  validPassword,
  verifyPassword,
} from './auth.js';
import {
  assertCanManageOrg,
  assertOrgVisible,
  assertOwnerAdmin,
  loadVisibleMachine,
  locationVisible,
  visibleOrgIds,
  type DevicePrincipal,
  type Principal,
  type UserPrincipal,
} from './access.js';
import { bad, forbidden, HttpError, json, notFound, readJson, Router } from './http.js';
import { ingestForSource, loadMachine, recomputeDirtyDays, refitCalibrations, type IngestRecord } from './ingest.js';
import { oilLevelAnalysis, summarize } from './state.js';
import { SENSORS } from './domain/sensors.js';
import { forecast } from './domain/service.js';
import { encryptSecret } from './secrets.js';
import { fetchUnits, syncConnector } from './connectors/sync.js';
import { wialonLoginUrl } from './connectors/wialon.js';
import { ConnectorError } from './connectors/types.js';

export const APP_VERSION = '0.2.0';

export interface Ctx {
  req: Request;
  url: URL;
  db: Db;
  p: Principal | null;
  viaCookie: boolean;
}

const CATEGORIES = new Set([
  'harvester', 'forwarder', 'skidder', 'timber_truck', 'tractor', 'combine', 'forage_harvester', 'sprayer',
  'excavator', 'loader', 'dozer', 'grader', 'roller', 'crane', 'telehandler', 'dump_truck', 'truck', 'drill', 'other',
]);
const SESSION_DAYS = 30;

function user(c: Ctx): UserPrincipal {
  if (!c.p || c.p.kind !== 'user') throw new HttpError(401, 'unauthorized', 'Требуется вход');
  return c.p;
}
function device(c: Ctx): DevicePrincipal {
  if (!c.p || c.p.kind !== 'device') throw new HttpError(401, 'unauthorized', 'Устройство не сопряжено');
  return c.p;
}
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function audit(db: Db, u: UserPrincipal | null, action: string, details: unknown = null) {
  await db.query(`insert into audit_log (user_id, org_id, action, details) values ($1, $2, $3, $4)`, [
    u?.id ?? null,
    u?.org_id ?? null,
    action,
    details === null ? null : JSON.stringify(details),
  ]);
}

function sessionCookie(c: Ctx, token: string, maxAge: number): string {
  const secure = c.url.protocol === 'https:' ? '; Secure' : '';
  return `itles_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function createSession(c: Ctx, userId: string) {
  const token = newToken();
  await c.db.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)],
  );
  return token;
}

async function meView(db: Db, userId: string) {
  const r = await db.query<any>(
    `select u.id, u.login, u.role, u.label, o.id as org_id, o.kind as org_kind, o.name as org_name,
            o.share_location_up, o.tz
       from users u join orgs o on o.id = u.org_id where u.id = $1`,
    [userId],
  );
  return r.rows[0];
}

export const router = new Router<Ctx>();

// ---------------------------------------------------------------- setup & auth

router.on('GET', '/api/health', async (c) => {
  await c.db.query('select 1');
  return json({ ok: true, version: APP_VERSION, db: c.db.kind, time: new Date().toISOString() });
});

router.on('GET', '/api/setup/status', async (c) => {
  const r = await c.db.query<{ n: number }>(`select count(*)::int as n from orgs`);
  return json({ needs_setup: r.rows[0].n === 0, setup_key_configured: !!process.env.SETUP_KEY });
});

router.on('POST', '/api/setup', async (c) => {
  const b = await readJson(c.req);
  const key = process.env.SETUP_KEY;
  if (!key) throw new HttpError(503, 'setup_disabled', 'SETUP_KEY не задан на сервере');
  const given = String(b.setup_key ?? '');
  if (given.length !== key.length || !timingSafeEqual(Buffer.from(given), Buffer.from(key)))
    throw forbidden('Неверный ключ установки');
  if (!validLogin(b.login)) throw bad('bad_login', 'Логин: 3–40 символов, латиница в нижнем регистре, цифры, . _ -');
  if (!validPassword(b.password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  const orgName = str(b.org_name, 120) ?? 'FUCHS';
  const userId = randomUUID();
  const created = await c.db.tx(async (db) => {
    const n = await db.query<{ n: number }>(`select count(*)::int as n from orgs`);
    if (n.rows[0].n > 0) return false;
    const orgId = randomUUID();
    await db.query(`insert into orgs (id, kind, name) values ($1, 'fuchs', $2)`, [orgId, orgName]);
    await db.query(`insert into users (id, org_id, login, pass_hash, role) values ($1, $2, $3, $4, 'admin')`, [
      userId,
      orgId,
      b.login,
      await hashPassword(b.password),
    ]);
    return true;
  });
  if (!created) throw new HttpError(409, 'already_setup', 'Система уже инициализирована');
  const token = await createSession(c, userId);
  return json({ token, user: await meView(c.db, userId) }, 201, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

router.on('POST', '/api/auth/login', async (c) => {
  const b = await readJson(c.req);
  const login = String(b.login ?? '').trim().toLowerCase();
  const fails = await c.db.query<{ n: number }>(
    `select count(*)::int as n from audit_log
      where action = 'login_failed' and details->>'login' = $1 and t > now() - interval '15 minutes'`,
    [login],
  );
  if (fails.rows[0].n >= 10) throw new HttpError(429, 'locked', 'Слишком много попыток. Повторите через 15 минут');
  const r = await c.db.query<any>(`select id, pass_hash, disabled from users where login = $1`, [login]);
  const u = r.rows[0];
  const ok = u && !u.disabled && (await verifyPassword(String(b.password ?? ''), u.pass_hash));
  if (!ok) {
    await audit(c.db, null, 'login_failed', { login });
    throw new HttpError(401, 'bad_credentials', 'Неверный логин или пароль');
  }
  const token = await createSession(c, u.id);
  return json({ token, user: await meView(c.db, u.id) }, 200, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

router.on('POST', '/api/auth/logout', async (c) => {
  const auth = c.req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : readCookie(c.req, 'itles_session');
  if (token) await c.db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(c, '', 0) });
});

router.on('GET', '/api/me', async (c) => json({ user: await meView(c.db, user(c).id) }));

router.on('POST', '/api/auth/redeem', async (c) => {
  const b = await readJson(c.req);
  const code = normalizeCode(String(b.code ?? ''));
  if (!validLogin(b.login)) throw bad('bad_login', 'Логин: 3–40 символов, латиница в нижнем регистре, цифры, . _ -');
  if (!validPassword(b.password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  const userId = randomUUID();
  const passHash = await hashPassword(b.password);
  await c.db.tx(async (db) => {
    const inv = await db.query<any>(
      `select code_hash, org_id, role from invites where code_hash = $1 and used_at is null and expires_at > now() for update`,
      [sha256(code)],
    );
    if (!inv.rows[0]) throw bad('bad_code', 'Код приглашения недействителен или уже использован');
    const exists = await db.query(`select 1 from users where login = $1`, [b.login]);
    if (exists.rows.length) throw new HttpError(409, 'login_taken', 'Такой логин уже занят');
    await db.query(`insert into users (id, org_id, login, pass_hash, role) values ($1, $2, $3, $4, $5)`, [
      userId,
      inv.rows[0].org_id,
      b.login,
      passHash,
      inv.rows[0].role,
    ]);
    await db.query(`update invites set used_at = now(), used_by = $2 where code_hash = $1`, [inv.rows[0].code_hash, userId]);
  });
  const token = await createSession(c, userId);
  return json({ token, user: await meView(c.db, userId) }, 201, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

router.on('POST', '/api/auth/password', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const r = await c.db.query<any>(`select pass_hash from users where id = $1`, [u.id]);
  if (!(await verifyPassword(String(b.old_password ?? ''), r.rows[0].pass_hash))) throw forbidden('Текущий пароль неверен');
  if (!validPassword(b.new_password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  await c.db.query(`update users set pass_hash = $2 where id = $1`, [u.id, await hashPassword(b.new_password)]);
  await c.db.query(`delete from sessions where user_id = $1`, [u.id]);
  const token = await createSession(c, u.id);
  return json({ token }, 200, { 'set-cookie': sessionCookie(c, token, SESSION_DAYS * 86400) });
});

// ---------------------------------------------------------------- organizations & users

router.on('GET', '/api/orgs', async (c) => {
  const u = user(c);
  const ids = await visibleOrgIds(c.db, u);
  const r = await c.db.query<any>(
    `select o.id, o.kind, o.name, o.parent_id, o.tz, o.share_location_up,
            (select count(*)::int from machines m where m.org_id = o.id and not m.archived) as machines,
            (select count(*)::int from users x where x.org_id = o.id and not x.disabled) as users
       from orgs o where o.id = any($1::text[]) order by o.kind, o.name`,
    [ids],
  );
  return json({ orgs: r.rows });
});

router.on('POST', '/api/orgs', async (c) => {
  const u = user(c);
  if (u.role !== 'admin') throw forbidden();
  const b = await readJson(c.req);
  const name = str(b.name, 120);
  if (!name) throw bad('bad_name', 'Укажите название');
  let kind: string;
  let parent: string;
  if (u.org_kind === 'fuchs') {
    kind = b.kind === 'customer' ? 'customer' : 'distributor';
    parent = kind === 'customer' && typeof b.parent_id === 'string' ? b.parent_id : u.org_id;
    if (kind === 'customer' && parent !== u.org_id) {
      const p = await c.db.query<any>(`select kind from orgs where id = $1`, [parent]);
      if (p.rows[0]?.kind !== 'distributor') throw bad('bad_parent', 'Клиент привязывается к дистрибьютору');
    }
  } else if (u.org_kind === 'distributor') {
    kind = 'customer';
    parent = u.org_id;
  } else throw forbidden('Клиент не создаёт другие организации');
  const id = randomUUID();
  await c.db.query(`insert into orgs (id, kind, name, parent_id, tz) values ($1, $2, $3, $4, $5)`, [
    id,
    kind,
    name,
    parent,
    str(b.tz, 64) ?? 'Europe/Moscow',
  ]);
  await audit(c.db, u, 'org_created', { id, kind, name });
  return json({ org: { id, kind, name, parent_id: parent } }, 201);
});

router.on('PATCH', '/api/orgs/:id', async (c, { id }) => {
  const u = user(c);
  await assertOrgVisible(c.db, u, id);
  const b = await readJson(c.req);
  if (b.share_location_up !== undefined) {
    assertOwnerAdmin(u, id);
    await c.db.query(`update orgs set share_location_up = $2 where id = $1`, [id, !!b.share_location_up]);
    await audit(c.db, u, 'share_location_up', { org: id, value: !!b.share_location_up });
  }
  if (b.name !== undefined || b.tz !== undefined) {
    await assertCanManageOrg(c.db, u, id);
    if (b.tz !== undefined) {
      const tz = String(b.tz);
      const ok = await c.db.query(`select 1 from pg_timezone_names where name = $1`, [tz]);
      if (!ok.rows.length) throw bad('bad_tz', 'Неизвестный часовой пояс');
      await c.db.query(`update orgs set tz = $2 where id = $1`, [id, tz]);
    }
    const name = str(b.name, 120);
    if (name) await c.db.query(`update orgs set name = $2 where id = $1`, [id, name]);
  }
  return json({ ok: true });
});

router.on('POST', '/api/orgs/:id/invites', async (c, { id }) => {
  const u = user(c);
  await assertCanManageOrg(c.db, u, id);
  const b = await readJson(c.req);
  const role = b.role === 'admin' ? 'admin' : 'member';
  const code = newInviteCode();
  await c.db.query(
    `insert into invites (code_hash, org_id, role, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '7 days')`,
    [sha256(normalizeCode(code)), id, role, u.id],
  );
  await audit(c.db, u, 'invite_created', { org: id, role });
  return json({ code, role, expires_in_days: 7 }, 201);
});

router.on('GET', '/api/orgs/:id/users', async (c, { id }) => {
  const u = user(c);
  await assertCanManageOrg(c.db, u, id);
  const r = await c.db.query<any>(
    `select id, login, role, label, disabled, created_at from users where org_id = $1 order by login`,
    [id],
  );
  return json({ users: r.rows });
});

router.on('PATCH', '/api/users/:id', async (c, { id }) => {
  const u = user(c);
  const t = (await c.db.query<any>(`select org_id from users where id = $1`, [id])).rows[0];
  if (!t) throw notFound();
  await assertCanManageOrg(c.db, u, t.org_id);
  if (id === u.id) throw bad('self', 'Нельзя изменить собственную учётную запись этим способом');
  const b = await readJson(c.req);
  if (b.disabled !== undefined) {
    await c.db.query(`update users set disabled = $2 where id = $1`, [id, !!b.disabled]);
    if (b.disabled) await c.db.query(`delete from sessions where user_id = $1`, [id]);
  }
  if (b.role === 'admin' || b.role === 'member') await c.db.query(`update users set role = $2 where id = $1`, [id, b.role]);
  if (b.label !== undefined) await c.db.query(`update users set label = $2 where id = $1`, [id, str(b.label, 80)]);
  return json({ ok: true });
});

router.on('POST', '/api/users/:id/password', async (c, { id }) => {
  const u = user(c);
  const t = (await c.db.query<any>(`select org_id from users where id = $1`, [id])).rows[0];
  if (!t) throw notFound();
  await assertCanManageOrg(c.db, u, t.org_id);
  const b = await readJson(c.req);
  if (!validPassword(b.password)) throw bad('bad_password', 'Пароль: не короче 8 символов');
  await c.db.query(`update users set pass_hash = $2 where id = $1`, [id, await hashPassword(b.password)]);
  await c.db.query(`delete from sessions where user_id = $1`, [id]);
  await audit(c.db, u, 'password_reset', { user: id });
  return json({ ok: true });
});

// ---------------------------------------------------------------- machines

async function visibleMachineIds(c: Ctx, u: UserPrincipal, orgId?: string | null): Promise<string[]> {
  const orgs = await visibleOrgIds(c.db, u);
  const scope = orgId ? orgs.filter((o) => o === orgId) : orgs;
  const r = await c.db.query<{ id: string }>(
    `select id from machines where org_id = any($1::text[]) and not archived`,
    [scope],
  );
  return r.rows.map((x) => x.id);
}

router.on('GET', '/api/machines', async (c) => {
  const u = user(c);
  const ids = await visibleMachineIds(c, u, c.url.searchParams.get('org_id'));
  return json({ machines: await summarize(c.db, ids, u.org_id), now: Date.now() });
});

function machineFields(b: any, partial: boolean) {
  const out: Record<string, unknown> = {};
  const name = str(b.name, 120);
  if (name) out.name = name;
  else if (!partial) throw bad('bad_name', 'Укажите название или гаражный номер');
  if (b.category !== undefined) {
    if (!CATEGORIES.has(b.category)) throw bad('bad_category', 'Неизвестная категория техники');
    out.category = b.category;
  } else if (!partial) out.category = 'other';
  for (const k of ['make', 'model'] as const) if (b[k] !== undefined) out[k] = str(b[k], 80);
  if (b.year !== undefined) {
    const y = b.year === null || b.year === '' ? null : Number(b.year);
    if (y !== null && (!Number.isInteger(y) || y < 1950 || y > 2100)) throw bad('bad_year', 'Неверный год выпуска');
    out.year = y;
  }
  if (b.chassis !== undefined) {
    if (b.chassis !== 'wheeled' && b.chassis !== 'tracked') throw bad('bad_chassis', 'Ходовая: колёсная или гусеничная');
    out.chassis = b.chassis;
  }
  if (b.rotating_upper !== undefined) out.rotating_upper = !!b.rotating_upper;
  return out;
}

router.on('POST', '/api/machines', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const orgId = typeof b.org_id === 'string' ? b.org_id : u.org_id;
  await assertCanManageOrg(c.db, u, orgId);
  const kind = (await c.db.query<any>(`select kind from orgs where id = $1`, [orgId])).rows[0]?.kind;
  if (kind !== 'customer') throw bad('bad_org', 'Технику добавляют в организацию-клиента (владельца техники)');
  const f = machineFields(b, false);
  const id = randomUUID();
  const cols = ['id', 'org_id', ...Object.keys(f)];
  const vals = [id, orgId, ...Object.values(f)];
  await c.db.query(`insert into machines (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
  await audit(c.db, u, 'machine_created', { id, org: orgId });
  return json({ machine: (await summarize(c.db, [id], u.org_id))[0] }, 201);
});

router.on('GET', '/api/machines/:id', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  const [summary] = await summarize(c.db, [id], u.org_id);
  const items = await c.db.query<any>(
    `select id, item, interval_h, last_done_h, volume_l, product,
            (extract(epoch from last_done_at) * 1000)::float8 as last_done_at
       from service_items where machine_id = $1 order by item`,
    [id],
  );
  const avg = await avgDailyHours(c.db, id);
  const cals = await c.db.query<any>(
    `select c.source_id, c.metric, c.scale, c.offset_value, c.basis from calibrations c
       join sources s on s.id = c.source_id where s.machine_id = $1`,
    [id],
  );
  const conns = await c.db.query<any>(
    `select s.id, s.kind, s.external_id, s.label, s.connector_id, k.label as connector_label,
            (extract(epoch from s.enroll_expires_at) * 1000)::float8 as enroll_expires_at,
            s.token_hash is not null as paired
       from sources s left join connectors k on k.id = s.connector_id where s.machine_id = $1 order by s.created_at`,
    [id],
  );
  return json({
    machine: summary,
    oil_level: await oilLevelAnalysis(c.db, id),
    service: forecast(items.rows, summary?.engine_hours?.value ?? null, avg),
    avg_daily_hours: avg,
    calibrations: cals.rows,
    sources: conns.rows,
  });
});

router.on('PATCH', '/api/machines/:id', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  const b = await readJson(c.req);
  if (b.location_enabled !== undefined) {
    assertOwnerAdmin(u, m.org_id);
    await c.db.query(`update machines set location_enabled = $2 where id = $1`, [id, !!b.location_enabled]);
    await audit(c.db, u, 'location_enabled', { machine: id, value: !!b.location_enabled });
  }
  const f = machineFields(b, true);
  delete (f as any).location_enabled;
  if (Object.keys(f).length) {
    await assertCanManageOrg(c.db, u, m.org_id);
    const sets = Object.keys(f).map((k, i) => `${k} = $${i + 2}`);
    await c.db.query(`update machines set ${sets.join(', ')} where id = $1`, [id, ...Object.values(f)]);
    if ('chassis' in f || 'rotating_upper' in f || 'category' in f) {
      await c.db.query(`update daily_stats set dirty = true where machine_id = $1`, [id]);
      const mr = await loadMachine(c.db, id);
      if (mr) await recomputeDirtyDays(c.db, mr, 60);
    }
  }
  return json({ machine: (await summarize(c.db, [id], u.org_id))[0] });
});

router.on('DELETE', '/api/machines/:id', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCanManageOrg(c.db, u, m.org_id);
  await c.db.query(`update machines set archived = true where id = $1`, [id]);
  await c.db.query(`update sources set token_hash = null, enroll_code_hash = null where machine_id = $1`, [id]);
  await audit(c.db, u, 'machine_archived', { machine: id });
  return json({ ok: true });
});

router.on('DELETE', '/api/machines/:id/positions', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  assertOwnerAdmin(u, m.org_id);
  const r = await c.db.query(`delete from positions where machine_id = $1`, [id]);
  await c.db.query(`update daily_stats set gnss_km = 0, transport_km = 0, points = 0, first_t = null, last_t = null where machine_id = $1`, [id]);
  await audit(c.db, u, 'positions_purged', { machine: id, rows: r.rowCount });
  return json({ deleted: r.rowCount });
});

router.on('GET', '/api/machines/:id/track', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  if (!locationVisible(u, m)) throw new HttpError(403, 'location_disabled', 'Местоположение этой машины недоступно');
  const to = c.url.searchParams.get('to') ? Date.parse(c.url.searchParams.get('to')!) : Date.now();
  const from = c.url.searchParams.get('from') ? Date.parse(c.url.searchParams.get('from')!) : to - 86400e3;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw bad('bad_range');
  if (to - from > 31 * 86400e3) throw bad('range_too_long', 'Не более 31 суток за запрос');
  const r = await c.db.query<any>(
    `select (extract(epoch from t) * 1000)::float8 as t, lat, lon, speed_kmh, course
       from positions where machine_id = $1 and t >= to_timestamp($2 / 1000.0) and t <= to_timestamp($3 / 1000.0)
      order by t`,
    [id, from, to],
  );
  const rows = r.rows;
  const step = Math.max(1, Math.ceil(rows.length / 5000));
  const points = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((p) => [Number(p.t), p.lat, p.lon, p.speed_kmh]);
  return json({ points, total: rows.length, decimated: step > 1 });
});

async function avgDailyHours(db: Db, machineId: string): Promise<number | null> {
  const r = await db.query<any>(
    `with best as (
       select c.source_id from counters c where c.machine_id = $1 and c.metric = 'engine_hours'
          and c.t > now() - interval '30 days'
        group by c.source_id order by count(*) desc limit 1
     )
     select (max(value) - min(value))::float8 as dh,
            (extract(epoch from max(t) - min(t)) / 86400)::float8 as days
       from counters where source_id = (select source_id from best) and metric = 'engine_hours'
        and t > now() - interval '30 days'`,
    [machineId],
  );
  const row = r.rows[0];
  if (row?.dh === null || row?.dh === undefined || !row.days || row.days < 3) return null;
  return row.dh / Math.max(row.days, 1);
}

router.on('GET', '/api/machines/:id/daily', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  const days = Math.min(366, Math.max(1, Number(c.url.searchParams.get('days') ?? 30)));
  const tz = (await c.db.query<any>(`select tz from orgs where id = $1`, [m.org_id])).rows[0].tz;
  const km = await c.db.query<any>(
    `select day::text as day, gnss_km, transport_km, points from daily_stats
      where machine_id = $1 and day > (now() at time zone $2)::date - $3::int order by day`,
    [id, tz, days],
  );
  const hours = await c.db.query<any>(
    `select (t at time zone $2)::date::text as day, source_id, (max(value) - min(value))::float8 as dh, count(*)::int as n
       from counters where machine_id = $1 and metric = 'engine_hours' and t > now() - ($3::int || ' days')::interval
      group by 1, 2`,
    [id, tz, days + 1],
  );
  const byDay = new Map<string, { dh: number; n: number }>();
  for (const h of hours.rows) {
    const prev = byDay.get(h.day);
    if (!prev || h.n > prev.n) byDay.set(h.day, { dh: h.dh, n: h.n });
  }
  const allDays = new Set([...km.rows.map((r) => r.day), ...byDay.keys()]);
  const out = [...allDays].sort().map((day) => {
    const k = km.rows.find((r) => r.day === day);
    return {
      day,
      gnss_km: m.location_enabled ? (k?.gnss_km ?? 0) : null,
      transport_km: m.location_enabled ? (k?.transport_km ?? 0) : null,
      points: k?.points ?? 0,
      engine_hours: byDay.get(day)?.dh ?? null,
    };
  });
  return json({ days: out });
});

router.on('GET', '/api/machines/:id/counters', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  const metric = c.url.searchParams.get('metric') === 'odometer_km' ? 'odometer_km' : 'engine_hours';
  const days = Math.min(366, Math.max(1, Number(c.url.searchParams.get('days') ?? 30)));
  const r = await c.db.query<any>(
    `select c.source_id, s.kind, c.method, (extract(epoch from c.t) * 1000)::float8 as t, c.value,
            coalesce(k.scale, 1) as scale, coalesce(k.offset_value, 0) as offset_value
       from counters c join sources s on s.id = c.source_id
       left join calibrations k on k.source_id = c.source_id and k.metric = c.metric
      where c.machine_id = $1 and c.metric = $2 and c.t > now() - ($3::int || ' days')::interval
      order by c.t`,
    [id, metric, days],
  );
  const series: Record<string, any> = {};
  for (const row of r.rows) {
    const s = (series[row.source_id] ??= { source_id: row.source_id, kind: row.kind, method: row.method, points: [] });
    s.points.push([Number(row.t), Number(row.value) * row.scale + row.offset_value]);
  }
  for (const s of Object.values(series) as any[]) {
    const step = Math.max(1, Math.ceil(s.points.length / 2000));
    s.points = s.points.filter((_: unknown, i: number) => i % step === 0 || i === s.points.length - 1);
  }
  const readings = await c.db.query<any>(
    `select id, value, (extract(epoch from t) * 1000)::float8 as t, photo is not null as has_photo, entered_by
       from readings where machine_id = $1 and metric = $2 order by t desc limit 200`,
    [id, metric],
  );
  return json({ metric, series: Object.values(series), readings: readings.rows });
});

router.on('GET', '/api/machines/:id/sensors', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  const key = c.url.searchParams.get('key') ?? 'oil_level_pct';
  if (!SENSORS[key]) throw bad('bad_key', 'Неизвестный показатель');
  const days = Math.min(366, Math.max(1, Number(c.url.searchParams.get('days') ?? 30)));
  const r = await c.db.query<any>(
    `select (extract(epoch from t) * 1000)::float8 as t, value from sensor_readings
      where machine_id = $1 and key = $2 and t > now() - ($3::int || ' days')::interval order by t`,
    [id, key, days],
  );
  const step = Math.max(1, Math.ceil(r.rows.length / 1500));
  const points = r.rows.filter((_, i) => i % step === 0 || i === r.rows.length - 1).map((x) => [Number(x.t), Number(x.value)]);
  return json({ key, points, total: r.rows.length });
});

router.on('GET', '/api/oil/overview', async (c) => {
  const u = user(c);
  const ids = await visibleMachineIds(c, u, c.url.searchParams.get('org_id'));
  const machines = (await summarize(c.db, ids, u.org_id)).filter((m) => m.oil);
  const rows = [];
  for (const m of machines) {
    const lv = m.oil!.values.oil_level_pct ? await oilLevelAnalysis(c.db, m.id) : null;
    rows.push({
      id: m.id, name: m.name, org_name: m.org_name, category: m.category, engine_hours: m.engine_hours?.value ?? null,
      oil: m.oil, topups_30d: lv?.topups.length ?? null, consumption_pct_per_100h: lv?.consumption_pct_per_100h ?? null,
    });
  }
  const rank = { crit: 0, warn: 1, ok: 2 } as Record<string, number>;
  rows.sort((a, b) => (rank[a.oil!.status ?? 'ok'] ?? 3) - (rank[b.oil!.status ?? 'ok'] ?? 3) || a.name.localeCompare(b.name));
  return json({ machines: rows, sensors: SENSORS });
});

router.on('POST', '/api/machines/:id/readings', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  if (u.org_id !== m.org_id) await assertCanManageOrg(c.db, u, m.org_id);
  const b = await readJson(c.req, 3_000_000);
  const metric = b.metric === 'odometer_km' ? 'odometer_km' : 'engine_hours';
  const value = finite(b.value);
  if (value === null || value < 0 || value > (metric === 'engine_hours' ? 300000 : 10_000_000))
    throw bad('bad_value', 'Неверное показание счётчика');
  const t = b.t ? Date.parse(b.t) : Date.now();
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60e3) throw bad('bad_time', 'Неверное время показания');
  const photo = typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : null;
  const prev = await c.db.query<any>(
    `select value from readings where machine_id = $1 and metric = $2 and t <= to_timestamp($3 / 1000.0) order by t desc limit 1`,
    [id, metric, t],
  );
  if (prev.rows[0] && value < Number(prev.rows[0].value) && !b.confirm_decrease)
    throw new HttpError(409, 'decrease', `Показание меньше предыдущего (${prev.rows[0].value}). Если счётчик заменён, подтвердите.`);
  const rid = randomUUID();
  await c.db.query(
    `insert into readings (id, machine_id, metric, value, t, photo, entered_by) values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)`,
    [rid, id, metric, value, t, photo, u.id],
  );
  await refitCalibrations(c.db, id, metric);
  return json({ id: rid, machine: (await summarize(c.db, [id], u.org_id))[0] }, 201);
});

router.on('DELETE', '/api/readings/:id', async (c, { id }) => {
  const u = user(c);
  const r = (await c.db.query<any>(`select machine_id, metric from readings where id = $1`, [id])).rows[0];
  if (!r) throw notFound();
  const m = await loadVisibleMachine(c.db, u, r.machine_id);
  await assertCanManageOrg(c.db, u, m.org_id);
  await c.db.query(`delete from readings where id = $1`, [id]);
  await refitCalibrations(c.db, r.machine_id, r.metric);
  return json({ ok: true });
});

router.on('GET', '/api/readings/:id/photo', async (c, { id }) => {
  const u = user(c);
  const r = (await c.db.query<any>(`select machine_id, photo from readings where id = $1`, [id])).rows[0];
  if (!r?.photo) throw notFound();
  await loadVisibleMachine(c.db, u, r.machine_id);
  const [, mime, b64] = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(r.photo) ?? [];
  if (!mime) throw notFound();
  return new Response(Buffer.from(b64, 'base64'), { headers: { 'content-type': mime, 'cache-control': 'private, max-age=86400' } });
});

// ---------------------------------------------------------------- data sources

router.on('POST', '/api/machines/:id/sources', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCanManageOrg(c.db, u, m.org_id);
  const b = await readJson(c.req);
  const sid = randomUUID();
  if (b.kind === 'phone') {
    const code = newPairingCode();
    await c.db.query(
      `insert into sources (id, org_id, machine_id, kind, label, enroll_code_hash, enroll_expires_at)
       values ($1, $2, $3, 'phone', $4, $5, now() + interval '24 hours')`,
      [sid, m.org_id, id, str(b.label, 80) ?? 'Телефон в кабине', sha256('pair:' + code)],
    );
    return json({ source_id: sid, pairing_code: code, expires_in_hours: 24 }, 201);
  }
  if (b.kind === 'tracker') {
    const ext = String(b.external_id ?? '').replace(/\s/g, '');
    if (!/^\d{5,20}$/.test(ext)) throw bad('bad_imei', 'Укажите IMEI (15 цифр) или идентификатор терминала');
    const dup = await c.db.query(`select machine_id from sources where kind = 'tracker' and external_id = $1`, [ext]);
    if (dup.rows.length) throw new HttpError(409, 'imei_taken', 'Этот трекер уже привязан к другой машине');
    await c.db.query(
      `insert into sources (id, org_id, machine_id, kind, external_id, label) values ($1, $2, $3, 'tracker', $4, $5)`,
      [sid, m.org_id, id, ext, str(b.label, 80) ?? 'Трекер'],
    );
    return json({ source_id: sid, external_id: ext }, 201);
  }
  throw bad('bad_kind', 'Тип источника: phone или tracker (платформы подключаются через раздел «Подключения»)');
});

router.on('POST', '/api/sources/:id/pairing', async (c, { id }) => {
  const u = user(c);
  const s = (await c.db.query<any>(`select machine_id, kind from sources where id = $1`, [id])).rows[0];
  if (!s || s.kind !== 'phone') throw notFound();
  const m = await loadVisibleMachine(c.db, u, s.machine_id);
  await assertCanManageOrg(c.db, u, m.org_id);
  const code = newPairingCode();
  await c.db.query(
    `update sources set enroll_code_hash = $2, enroll_expires_at = now() + interval '24 hours', token_hash = null where id = $1`,
    [id, sha256('pair:' + code)],
  );
  return json({ pairing_code: code, expires_in_hours: 24 });
});

router.on('DELETE', '/api/sources/:id', async (c, { id }) => {
  const u = user(c);
  const s = (await c.db.query<any>(`select machine_id from sources where id = $1`, [id])).rows[0];
  if (!s) throw notFound();
  const m = await loadVisibleMachine(c.db, u, s.machine_id);
  await assertCanManageOrg(c.db, u, m.org_id);
  // data already received stays with the machine; the source just stops being accepted
  await c.db.query(
    `update sources set token_hash = null, enroll_code_hash = null, external_id = case when kind = 'tracker' then null else external_id end,
            label = coalesce(label, '') || ' (отключён)' where id = $1`,
    [id],
  );
  return json({ ok: true });
});

router.on('POST', '/api/devices/enroll', async (c) => {
  const b = await readJson(c.req);
  const code = String(b.code ?? '').replace(/\D/g, '');
  if (code.length !== 6) throw bad('bad_code', 'Код — 6 цифр');
  const token = newToken();
  const s = await c.db.tx(async (db) => {
    const r = await db.query<any>(
      `select id, machine_id from sources where enroll_code_hash = $1 and enroll_expires_at > now() for update`,
      [sha256('pair:' + code)],
    );
    if (!r.rows[0]) throw bad('bad_code', 'Код неверный или истёк. Получите новый код на странице машины');
    await db.query(`update sources set token_hash = $2, enroll_code_hash = null, enroll_expires_at = null where id = $1`, [
      r.rows[0].id,
      sha256(token),
    ]);
    return r.rows[0];
  });
  return json({ token, config: await deviceConfig(c.db, s.id) }, 201);
});

async function deviceConfig(db: Db, sourceId: string) {
  const r = await db.query<any>(
    `select s.id as source_id, m.id, m.name, m.category, m.chassis, m.rotating_upper, m.location_enabled, m.archived
       from sources s join machines m on m.id = s.machine_id where s.id = $1`,
    [sourceId],
  );
  const row = r.rows[0];
  if (!row) throw notFound();
  return {
    source_id: row.source_id,
    machine: { id: row.id, name: row.name, category: row.category, chassis: row.chassis, rotating_upper: row.rotating_upper },
    location_enabled: row.location_enabled && !row.archived,
    server_time: Date.now(),
  };
}

router.on('GET', '/api/devices/me', async (c) => json(await deviceConfig(c.db, device(c).source_id)));

/** Dashboard meter reading taken in the cab (photo + number), sent with the device token. */
router.on('POST', '/api/devices/reading', async (c) => {
  const d = device(c);
  if (!d.machine_id) throw bad('not_assigned', 'Телефон не привязан к машине');
  const b = await readJson(c.req, 3_000_000);
  const metric = b.metric === 'odometer_km' ? 'odometer_km' : 'engine_hours';
  const value = finite(b.value);
  if (value === null || value < 0 || value > (metric === 'engine_hours' ? 300000 : 10_000_000)) throw bad('bad_value', 'Неверное показание');
  const t = b.t ? Date.parse(b.t) : Date.now();
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60e3) throw bad('bad_time', 'Неверное время показания');
  const prev = await c.db.query<any>(
    `select value from readings where machine_id = $1 and metric = $2 and t <= to_timestamp($3 / 1000.0) order by t desc limit 1`,
    [d.machine_id, metric, t],
  );
  if (prev.rows[0] && value < Number(prev.rows[0].value) && !b.confirm_decrease)
    throw new HttpError(409, 'decrease', `Показание меньше предыдущего (${prev.rows[0].value}). Если счётчик заменён, подтвердите.`);
  const rid = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
  const photo = typeof b.photo === 'string' && b.photo.startsWith('data:image/') ? b.photo : null;
  const r = await c.db.query(
    `insert into readings (id, machine_id, metric, value, t, photo, source_id) values ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7)
     on conflict (id) do nothing`,
    [rid, d.machine_id, metric, value, t, photo, d.source_id],
  );
  if (r.rowCount) await refitCalibrations(c.db, d.machine_id, metric);
  return json({ id: rid, duplicate: r.rowCount === 0 }, 201);
});

router.on('POST', '/api/ingest', async (c) => {
  if (!c.p) throw new HttpError(401, 'unauthorized');
  const b = await readJson(c.req, 10_000_000);
  const records: any[] = Array.isArray(b.records) ? b.records : [];
  if (records.length > 20000) throw new HttpError(413, 'too_many', 'Не более 20000 записей за запрос');
  if (c.p.kind === 'device') {
    const s = (await c.db.query<any>(`select id, machine_id, org_id, kind from sources where id = $1`, [c.p.source_id])).rows[0];
    const res = await ingestForSource(c.db, s, records as IngestRecord[]);
    return json({ ...res, config: await deviceConfig(c.db, s.id) });
  }
  if (c.p.kind === 'gateway') {
    // records carry the tracker id; unknown ids are reported so the gateway keeps them queued
    const byExt = new Map<string, Array<{ i: number; r: any }>>();
    records.forEach((r, i) => {
      const ext = String(r?.ext_id ?? '');
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext)!.push({ i, r });
    });
    const results: any[] = [];
    for (const [ext, list] of byExt) {
      const s = (
        await c.db.query<any>(`select id, machine_id, org_id, kind from sources where kind = 'tracker' and external_id = $1`, [ext])
      ).rows[0];
      if (!s || !s.machine_id) {
        results.push({ ext_id: ext, status: 'unknown_device', indexes: list.map((x) => x.i) });
        continue;
      }
      const res = await ingestForSource(c.db, s, list.map((x) => x.r));
      results.push({
        ext_id: ext,
        status: 'ok',
        ...res,
        rejected: res.rejected.map((x) => ({ index: list[x.index].i, reason: x.reason })),
      });
    }
    return json({ results });
  }
  throw forbidden();
});

// ---------------------------------------------------------------- service (oil changes)

router.on('POST', '/api/machines/:id/service', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCanManageOrg(c.db, u, m.org_id);
  const b = await readJson(c.req);
  const item = str(b.item, 80);
  const interval = finite(b.interval_h);
  if (!item || interval === null || interval <= 0 || interval > 20000) throw bad('bad_item', 'Укажите узел и интервал в моточасах');
  const sid = randomUUID();
  await c.db.query(
    `insert into service_items (id, machine_id, item, interval_h, last_done_h, volume_l, product) values ($1,$2,$3,$4,$5,$6,$7)`,
    [sid, id, item, interval, finite(b.last_done_h) ?? 0, finite(b.volume_l), str(b.product, 120)],
  );
  return json({ id: sid }, 201);
});

router.on('PATCH', '/api/service/:id', async (c, { id }) => {
  const u = user(c);
  const it = (await c.db.query<any>(`select machine_id from service_items where id = $1`, [id])).rows[0];
  if (!it) throw notFound();
  const m = await loadVisibleMachine(c.db, u, it.machine_id);
  await assertCanManageOrg(c.db, u, m.org_id);
  const b = await readJson(c.req);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries({
    item: str(b.item, 80),
    interval_h: finite(b.interval_h),
    last_done_h: finite(b.last_done_h),
    volume_l: finite(b.volume_l),
    product: str(b.product, 120),
  })) {
    if (b[k] === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length) await c.db.query(`update service_items set ${sets.join(', ')} where id = $1`, vals);
  return json({ ok: true });
});

router.on('DELETE', '/api/service/:id', async (c, { id }) => {
  const u = user(c);
  const it = (await c.db.query<any>(`select machine_id from service_items where id = $1`, [id])).rows[0];
  if (!it) throw notFound();
  const m = await loadVisibleMachine(c.db, u, it.machine_id);
  await assertCanManageOrg(c.db, u, m.org_id);
  await c.db.query(`delete from service_items where id = $1`, [id]);
  return json({ ok: true });
});

router.on('POST', '/api/service/:id/done', async (c, { id }) => {
  const u = user(c);
  const it = (await c.db.query<any>(`select machine_id from service_items where id = $1`, [id])).rows[0];
  if (!it) throw notFound();
  const m = await loadVisibleMachine(c.db, u, it.machine_id);
  if (u.org_id !== m.org_id) await assertCanManageOrg(c.db, u, m.org_id);
  const b = await readJson(c.req);
  let at = finite(b.at_h);
  if (at === null) at = (await summarize(c.db, [it.machine_id], u.org_id))[0]?.engine_hours?.value ?? null;
  if (at === null) throw bad('no_hours', 'Моточасы машины неизвестны — укажите их явно');
  await c.db.query(`update service_items set last_done_h = $2, last_done_at = now() where id = $1`, [id, at]);
  return json({ ok: true, last_done_h: at });
});

router.on('GET', '/api/service/overview', async (c) => {
  const u = user(c);
  const ids = await visibleMachineIds(c, u, c.url.searchParams.get('org_id'));
  const machines = await summarize(c.db, ids, u.org_id);
  const items = ids.length
    ? await c.db.query<any>(
        `select id, machine_id, item, interval_h, last_done_h, volume_l, product from service_items where machine_id = any($1::text[])`,
        [ids],
      )
    : { rows: [] as any[] };
  const out: any[] = [];
  for (const m of machines) {
    const its = items.rows.filter((i) => i.machine_id === m.id);
    if (!its.length) continue;
    const avg = await avgDailyHours(c.db, m.id);
    for (const f of forecast(its, m.engine_hours?.value ?? null, avg))
      out.push({ machine_id: m.id, machine: m.name, org_id: m.org_id, org: m.org_name, hours: m.engine_hours?.value ?? null, ...f });
  }
  out.sort((a, b) => (a.remaining_h ?? 1e9) - (b.remaining_h ?? 1e9));
  return json({ items: out });
});

// ---------------------------------------------------------------- connectors

router.on('GET', '/api/connectors', async (c) => {
  const u = user(c);
  const orgs = await visibleOrgIds(c.db, u);
  const r = await c.db.query<any>(
    `select k.id, k.org_id, o.name as org_name, k.kind, k.label, k.base_url, k.status, k.last_error,
            (extract(epoch from k.last_sync_at) * 1000)::float8 as last_sync_at,
            (select count(*)::int from sources s where s.connector_id = k.id) as units
       from connectors k join orgs o on o.id = k.org_id where k.org_id = any($1::text[]) order by k.created_at`,
    [orgs],
  );
  return json({ connectors: r.rows });
});

router.on('GET', '/api/connectors/wialon/login-url', async (c) => {
  user(c);
  const host = c.url.searchParams.get('host') ?? 'https://hosting.wialon.com';
  const redirect = c.url.searchParams.get('redirect') ?? `${c.url.origin}/app/#/connect/wialon`;
  return json({ url: wialonLoginUrl(host, redirect) });
});

router.on('POST', '/api/connectors', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const orgId = typeof b.org_id === 'string' ? b.org_id : u.org_id;
  await assertCanManageOrg(c.db, u, orgId);
  const kind = String(b.kind);
  if (!['wialon', 'traccar', 'aemp'].includes(kind)) throw bad('bad_kind', 'Тип подключения: wialon, traccar или aemp');
  const baseUrl = str(b.base_url, 300);
  if (!baseUrl) throw bad('bad_url', 'Укажите адрес сервера');
  const secret: Record<string, string> = {};
  for (const k of ['token', 'email', 'password', 'username']) if (typeof b[k] === 'string' && b[k]) secret[k] = b[k];
  let units;
  try {
    units = await fetchUnits(kind, baseUrl, secret);
  } catch (e) {
    if (e instanceof ConnectorError) throw new HttpError(422, 'connector_' + e.code, e.message);
    throw e;
  }
  const id = randomUUID();
  await c.db.query(
    `insert into connectors (id, org_id, kind, label, base_url, secret_enc) values ($1, $2, $3, $4, $5, $6)`,
    [id, orgId, kind, str(b.label, 80) ?? `${kind} ${new URL(baseUrl).host}`, baseUrl, encryptSecret(JSON.stringify(secret))],
  );
  await audit(c.db, u, 'connector_created', { id, kind, units: units.length });
  const report = await syncConnector(c.db, id);
  return json({ id, units: units.length, report }, 201);
});

router.on('POST', '/api/connectors/:id/sync', async (c, { id }) => {
  const u = user(c);
  const k = (await c.db.query<any>(`select org_id from connectors where id = $1`, [id])).rows[0];
  if (!k) throw notFound();
  await assertOrgVisible(c.db, u, k.org_id);
  try {
    return json({ report: await syncConnector(c.db, id) });
  } catch (e) {
    if (e instanceof ConnectorError) throw new HttpError(422, 'connector_' + e.code, e.message);
    throw e;
  }
});

router.on('DELETE', '/api/connectors/:id', async (c, { id }) => {
  const u = user(c);
  const k = (await c.db.query<any>(`select org_id from connectors where id = $1`, [id])).rows[0];
  if (!k) throw notFound();
  await assertCanManageOrg(c.db, u, k.org_id);
  await c.db.query(`update sources set connector_id = null, external_id = null where connector_id = $1`, [id]);
  await c.db.query(`delete from connectors where id = $1`, [id]);
  return json({ ok: true });
});

/** Near-real-time refresh while someone is looking: sync connectors not synced in the last minute. */
router.on('POST', '/api/refresh', async (c) => {
  const u = user(c);
  const orgs = await visibleOrgIds(c.db, u);
  const due = await c.db.query<any>(
    `select id from connectors where org_id = any($1::text[]) and status <> 'disabled'
        and (last_sync_at is null or last_sync_at < now() - interval '60 seconds') order by last_sync_at nulls first limit 3`,
    [orgs],
  );
  const results: any[] = [];
  for (const { id } of due.rows) {
    try {
      const rep = await syncConnector(c.db, id, { historyHours: 2 });
      results.push({ id, ok: true, positions: rep.result.positions, counters: rep.result.counters });
    } catch (e: any) {
      results.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  return json({ synced: results });
});

router.on('GET', '/api/cron/daily', async (c) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || c.req.headers.get('authorization') !== `Bearer ${secret}`) throw forbidden();
  const conns = await c.db.query<any>(`select id from connectors where status <> 'disabled'`);
  const out: any[] = [];
  for (const { id } of conns.rows) {
    try {
      const r = await syncConnector(c.db, id, { historyHours: 26 });
      out.push({ id, ok: true, positions: r.result.positions });
    } catch (e: any) {
      out.push({ id, ok: false, error: String(e?.message ?? e) });
    }
  }
  const dirty = await c.db.query<any>(`select distinct machine_id from daily_stats where dirty`);
  for (const { machine_id } of dirty.rows) {
    const m = await loadMachine(c.db, machine_id);
    if (m) await recomputeDirtyDays(c.db, m, 400);
  }
  return json({ connectors: out, recomputed_machines: dirty.rows.length });
});

export function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get('cookie');
  if (!h) return null;
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
