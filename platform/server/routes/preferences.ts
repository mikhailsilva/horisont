import { getSetting, router, user } from '../core.js';
import { bad, json, readJson } from '../http.js';

router.on('GET', '/api/me/preferences', async (c) => {
  const u = user(c);
  return json({ preferences: await getSetting(c.db, `user:${u.id}:preferences`, {}) });
});

router.on('PATCH', '/api/me/preferences', async (c) => {
  const u = user(c);
  const b = await readJson(c.req);
  const allowed: Record<string, unknown[]> = {
    mapBase: ['scheme', 'satellite', 'hybrid', 'topo'], mapTheme: ['light', 'dark'], theme: ['light', 'dark'],
    mapRelief: [true, false],
  };
  if (!b || typeof b !== 'object' || Array.isArray(b) ||
      Object.entries(b).some(([key, value]) => !Object.hasOwn(allowed, key) || !allowed[key].includes(value)))
    throw bad('bad_preferences', 'Недопустимые настройки интерфейса');
  const r = await c.db.query<{ value: unknown }>(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = settings.value || excluded.value, updated_at = now()
     returning value`, [ `user:${u.id}:preferences`, JSON.stringify(b) ],
  );
  return json({ preferences: r.rows[0].value });
});
