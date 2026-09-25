import { assertCap, loadVisibleMachine } from '../access.js';
import { bad, json, readJson } from '../http.js';
import { router, user } from '../core.js';

const MAX_BYTES = 2 * 1024 * 1024;
const KEY = (id: string) => `machine:${id}:photo`;

function validatePhoto(value: unknown): string {
  if (typeof value !== 'string') throw bad('bad_photo', 'Загрузите изображение PNG, JPEG или WebP');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw bad('bad_photo', 'Поддерживаются только изображения PNG, JPEG и WebP');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_BYTES) throw bad('photo_too_large', 'Размер фотографии не должен превышать 2 МБ');
  if (bytes.toString('base64') !== match[2]) throw bad('bad_photo', 'Некорректное изображение');
  const mime = match[1];
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw bad('bad_photo', 'Формат изображения не соответствует типу файла');
  return value;
}

router.on('GET', '/api/machines/:id/photo', async (c, { id }) => {
  const u = user(c);
  await loadVisibleMachine(c.db, u, id);
  const r = await c.db.query<{ value: any }>('select value from settings where key = $1', [KEY(id)]);
  return json({ photo: r.rows[0]?.value?.data_url ?? null });
});

router.on('PATCH', '/api/machines/:id/photo', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCap(c.db, u, 'machines.edit', m.org_id, 'Фото машины меняют администратор или диспетчер');
  const b = await readJson(c.req);
  const dataUrl = validatePhoto(b?.data_url);
  await c.db.query(
    `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [KEY(id), JSON.stringify({ data_url: dataUrl })],
  );
  return json({ photo: dataUrl });
});

router.on('DELETE', '/api/machines/:id/photo', async (c, { id }) => {
  const u = user(c);
  const m = await loadVisibleMachine(c.db, u, id);
  await assertCap(c.db, u, 'machines.edit', m.org_id, 'Фото машины меняют администратор или диспетчер');
  await c.db.query('delete from settings where key = $1', [KEY(id)]);
  return json({ photo: null });
});
