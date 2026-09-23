import { useMemo, useState } from 'react';
import type { Me } from '../main';
import { api, apiBase, CATEGORY_RU, fmt, METHOD_RU, SOURCE_RU } from '../api';
import { Bars, ErrorLine, Fresh, MapView, Modal, useAsync } from '../ui';
import { Line, OilHowTo, STATUS_CLS, STATUS_RU, fmtSensor } from '../oil';
import { SENSORS } from '../../../server/domain/sensors';

const GATEWAY_HOST = 'gw.itles.ru';

async function fileToJpeg(file: File, max = 1280): Promise<string> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

function ReadingForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [metric, setMetric] = useState('engine_hours');
  const [value, setValue] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/api/machines/${id}/readings`, { metric, value: Number(value.replace(',', '.')), photo, confirm_decrease: confirm });
      setValue('');
      setPhoto(null);
      setConfirm(false);
      setErr(null);
      onDone();
    } catch (e: any) {
      setErr(e);
      if (e.code === 'decrease') setConfirm(true);
    }
  };
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <select className="input" value={metric} onChange={(e) => setMetric(e.target.value)}>
          <option value="engine_hours">Моточасы (счётчик на панели)</option>
          <option value="odometer_km">Одометр, км</option>
        </select>
        <input className="input tabular-nums" inputMode="decimal" placeholder="Показание" value={value} onChange={(e) => setValue(e.target.value)} required />
      </div>
      <label className="btn-ghost w-full cursor-pointer">
        {photo ? 'Фото прикреплено ✓' : 'Сфотографировать счётчик'}
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => e.target.files?.[0] && setPhoto(await fileToJpeg(e.target.files[0]))} />
      </label>
      {photo && <img src={photo} className="max-h-40 rounded-xl" alt="счётчик" />}
      <ErrorLine e={err} />
      <button className="btn-primary w-full">{confirm ? 'Подтвердить: счётчик заменён' : 'Сохранить показание'}</button>
    </form>
  );
}

function SourcesBlock({ id, sources, canManage, onChange }: { id: string; sources: any[]; canManage: boolean; onChange: () => void }) {
  const [pair, setPair] = useState<{ code: string } | null>(null);
  const [tracker, setTracker] = useState(false);
  const [imei, setImei] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const addPhone = async () => {
    const r = await api('POST', `/api/machines/${id}/sources`, { kind: 'phone' });
    setPair({ code: r.pairing_code });
    onChange();
  };
  const addTracker = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', `/api/machines/${id}/sources`, { kind: 'tracker', external_id: imei });
      setImei('');
      onChange();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="space-y-3">
      {sources.length === 0 && <p className="text-sm text-muted-foreground">Источников пока нет — подключите телефон, трекер или платформу.</p>}
      {sources.map((s) => (
        <div key={s.id} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
          <div>
            <div className="font-semibold">{SOURCE_RU[s.kind] ?? s.kind}</div>
            <div className="text-xs text-muted-foreground">
              {s.external_id ? `ID ${s.external_id}` : s.label} {s.connector_label ? '· ' + s.connector_label : ''}
              {s.kind === 'phone' && !s.paired ? ' · ожидает сопряжения' : ''}
            </div>
          </div>
          {canManage && (
            <button
              className="text-xs text-danger hover:underline"
              onClick={async () => {
                if (confirm('Отключить источник? Полученные данные сохранятся.')) {
                  await api('DELETE', `/api/sources/${s.id}`);
                  onChange();
                }
              }}
            >
              отключить
            </button>
          )}
        </div>
      ))}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={addPhone}>
            + Телефон в кабине
          </button>
          <button className="btn-ghost" onClick={() => setTracker(!tracker)}>
            + Трекер
          </button>
        </div>
      )}
      {tracker && (
        <form onSubmit={addTracker} className="space-y-2 rounded-xl bg-muted p-3 text-sm">
          <input className="input" placeholder="IMEI трекера (15 цифр)" inputMode="numeric" value={imei} onChange={(e) => setImei(e.target.value)} required />
          <div className="text-xs text-muted-foreground">
            В настройках трекера добавьте второй сервер (основной оставьте как есть): <b>{GATEWAY_HOST}</b>, порт по протоколу — EGTS <b>5037</b>, Wialon IPS{' '}
            <b>5039</b>, Galileosky <b>5034</b>. Для моточасов из CAN включите режим FMS/J1939.
          </div>
          <ErrorLine e={err} />
          <button className="btn-primary">Привязать трекер</button>
        </form>
      )}
      {pair && (
        <Modal title="Сопряжение телефона" onClose={() => setPair(null)}>
          <p className="text-sm text-muted-foreground">
            На телефоне в кабине откройте приложение ITles → «Телефон в кабине» и введите код. Код действует 24 часа.
          </p>
          <div className="my-5 text-center font-mono text-5xl font-bold tracking-[0.3em] text-primary">{pair.code}</div>
          <p className="text-center text-xs text-muted-foreground">
            или откройте на телефоне: {(apiBase() || location.origin) + '/app/#/cab?code=' + pair.code}
          </p>
        </Modal>
      )}
    </div>
  );
}

function ServiceBlock({ id, items, canManage, onChange }: { id: string; items: any[]; canManage: boolean; onChange: () => void }) {
  const [f, setF] = useState<any>({ item: 'Моторное масло', interval_h: 500 });
  const [open, setOpen] = useState(false);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('POST', `/api/machines/${id}/service`, {
      ...f,
      interval_h: Number(f.interval_h),
      last_done_h: Number(f.last_done_h ?? 0),
      volume_l: f.volume_l ? Number(f.volume_l) : undefined,
    });
    setOpen(false);
    onChange();
  };
  return (
    <div className="space-y-2">
      {items.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
          <div>
            <div className="font-semibold">
              {s.item} {s.product ? <span className="font-normal text-muted-foreground">· {s.product}</span> : null}
            </div>
            <div className="text-xs text-muted-foreground">
              каждые {fmt(s.interval_h, 0)} ч · следующая при {fmt(s.due_at_h, 0)} ч{s.volume_l ? ` · ${fmt(s.volume_l, 0)} л` : ''}
            </div>
          </div>
          <div className="text-right">
            <span className={`badge ${s.status === 'overdue' ? 'bg-danger/10 text-danger' : s.status === 'soon' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>
              {s.status === 'overdue' ? `просрочено на ${fmt(-s.remaining_h, 0)} ч` : Number.isFinite(s.remaining_h) ? `через ${fmt(s.remaining_h, 0)} ч` : 'нет моточасов'}
            </span>
            {s.due_date && <div className="text-[11px] text-muted-foreground">≈ {new Date(s.due_date).toLocaleDateString('ru-RU')}</div>}
            <button
              className="ml-2 text-xs text-primary hover:underline"
              onClick={async () => {
                await api('POST', `/api/service/${s.id}/done`, {});
                onChange();
              }}
            >
              выполнено
            </button>
          </div>
        </div>
      ))}
      {canManage && !open && (
        <button className="btn-ghost" onClick={() => setOpen(true)}>
          + Интервал обслуживания
        </button>
      )}
      {open && (
        <form onSubmit={add} className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-3">
          <input className="input col-span-2" value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} placeholder="Узел (моторное масло, гидравлика…)" />
          <input className="input" value={f.interval_h} onChange={(e) => setF({ ...f, interval_h: e.target.value })} placeholder="Интервал, ч" inputMode="numeric" />
          <input className="input" value={f.last_done_h ?? ''} onChange={(e) => setF({ ...f, last_done_h: e.target.value })} placeholder="Последняя замена, ч" inputMode="numeric" />
          <input className="input" value={f.volume_l ?? ''} onChange={(e) => setF({ ...f, volume_l: e.target.value })} placeholder="Объём, л" inputMode="decimal" />
          <input className="input" value={f.product ?? ''} onChange={(e) => setF({ ...f, product: e.target.value })} placeholder="Продукт FUCHS" />
          <button className="btn-primary col-span-2">Добавить</button>
        </form>
      )}
    </div>
  );
}

export function MachinePage({ id, me }: { id: string; me: Me }) {
  const [tick, setTick] = useState(0);
  const [range, setRange] = useState(1);
  const det = useAsync(() => api('GET', `/api/machines/${id}`), [id, tick]);
  const daily = useAsync(() => api('GET', `/api/machines/${id}/daily?days=30`), [id, tick]);
  const m = det.data?.machine;
  const track = useAsync(
    () =>
      m?.location_visible
        ? api('GET', `/api/machines/${id}/track?from=${new Date(Date.now() - range * 86400e3).toISOString()}`)
        : Promise.resolve({ points: [] }),
    [id, tick, range, m?.location_visible],
  );
  const oilKey = m?.oil?.values?.oil_level_pct ? 'oil_level_pct' : m?.oil ? Object.keys(m.oil.values)[0] : null;
  const oilSeries = useAsync(() => (oilKey ? api('GET', `/api/machines/${id}/sensors?key=${oilKey}&days=30`) : Promise.resolve({ points: [] })), [id, tick, oilKey]);
  const reload = () => setTick((x) => x + 1);
  const isOwnerAdmin = me.role === 'admin' && m && me.org_id === m.org_id;
  const canManage = me.role === 'admin';
  const line = useMemo(() => (track.data?.points ?? []).map((p: any) => [p[1], p[2]] as [number, number]), [track.data]);
  if (det.error) return <ErrorLine e={det.error} />;
  if (!m) return <div className="text-muted-foreground">Загрузка…</div>;
  const days = daily.data?.days ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <a href="#/" className="text-sm text-muted-foreground hover:text-primary">
            ← Парк
          </a>
          <h1 className="text-2xl font-bold">{m.name}</h1>
          <div className="text-sm text-muted-foreground">
            {CATEGORY_RU[m.category]} · {m.make ?? ''} {m.model ?? ''} {m.year ? `· ${m.year}` : ''} · {m.chassis === 'tracked' ? 'гусеничная' : 'колёсная'}
            {m.rotating_upper ? ', поворотная платформа' : ''} · {m.org_name}
          </div>
        </div>
        <Fresh f={m.freshness} t={m.last_data_t} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-5">
          <div className="label">Моточасы</div>
          <div className="text-3xl font-bold tabular-nums">
            {m.engine_hours ? (m.engine_hours.exact ? '' : '≈ ') + fmt(m.engine_hours.value, 1) : '—'} <span className="text-lg text-muted-foreground">ч</span>
          </div>
          {m.engine_hours && (
            <div className="mt-1 text-xs text-muted-foreground">
              {METHOD_RU[m.engine_hours.method]} · {new Date(m.engine_hours.t).toLocaleString('ru-RU')}
              {!m.engine_hours.exact && m.engine_hours.last_exact && (
                <div>
                  точное: {fmt(m.engine_hours.last_exact.value, 1)} ч ({METHOD_RU[m.engine_hours.last_exact.method]}, {new Date(m.engine_hours.last_exact.t).toLocaleDateString('ru-RU')})
                </div>
              )}
            </div>
          )}
        </div>
        <div className="card p-5">
          <div className="label">Пробег</div>
          <div className="text-3xl font-bold tabular-nums">
            {m.odometer ? fmt(m.odometer.value, 1) : '—'} <span className="text-lg text-muted-foreground">км</span>
          </div>
          {m.odometer && (
            <div className="mt-1 text-xs text-muted-foreground">
              {METHOD_RU[m.odometer.method] ?? m.odometer.method}
              {m.odometer.note ? ` · ${m.odometer.note}` : ''}
            </div>
          )}
        </div>
        <div className="card p-5">
          <div className="label">Местоположение</div>
          {!m.location_enabled ? (
            <div className="text-sm text-muted-foreground">Выключено главным администратором владельца: координаты этой машины не принимаются.</div>
          ) : !m.location_visible ? (
            <div className="text-sm text-muted-foreground">Владелец не делится местоположением.</div>
          ) : m.position ? (
            <div>
              <div className="text-lg font-semibold tabular-nums">
                {m.position.lat.toFixed(5)}, {m.position.lon.toFixed(5)}
              </div>
              <div className="text-xs text-muted-foreground">
                {m.position.speed_kmh !== null ? `${fmt(m.position.speed_kmh, 0)} км/ч · ` : ''}
                {new Date(m.position.t).toLocaleString('ru-RU')}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">Нет данных</div>
          )}
        </div>
      </div>

      <div className="card space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Масло</h2>
          {m.oil?.status && <span className={`badge ${STATUS_CLS[m.oil.status]}`}>{STATUS_RU[m.oil.status]}</span>}
        </div>
        {m.oil ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(m.oil.values as Record<string, any>).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border p-3" title={SENSORS[k]?.source}>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{SENSORS[k]?.label ?? k}</div>
                  <div className={`mt-1 text-xl font-semibold tabular-nums ${v.status === 'crit' ? 'text-danger' : v.status === 'warn' ? 'text-warning' : ''}`}>{fmtSensor(k, v.value)}</div>
                  <div className="text-[11px] text-muted-foreground">{new Date(v.t).toLocaleString('ru-RU')}</div>
                </div>
              ))}
            </div>
            {oilKey && (
              <div>
                <div className="label">{SENSORS[oilKey]?.label}, 30 дней</div>
                <Line points={oilSeries.data?.points ?? []} unit={SENSORS[oilKey]?.unit} />
              </div>
            )}
            {det.data.oil_level && (
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-lg bg-muted p-3">
                  <div className="text-muted-foreground">Расход масла</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {det.data.oil_level.consumption_pct_per_100h === null ? '—' : `${fmt(det.data.oil_level.consumption_pct_per_100h, 1)} % / 100 моточасов`}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {det.data.oil_level.hours ? `по ${fmt(det.data.oil_level.hours, 0)} моточасам` : 'нужно ≥ 20 моточасов и точные моточасы'}
                  </div>
                </div>
                <div className="rounded-lg bg-muted p-3 sm:col-span-2">
                  <div className="text-muted-foreground">Доливы за 30 дней: {det.data.oil_level.topups.length}</div>
                  <div className="mt-1 space-y-0.5 text-xs">
                    {det.data.oil_level.topups.slice(-4).map((t: any) => (
                      <div key={t.t} className="tabular-nums">
                        {new Date(t.t).toLocaleString('ru-RU')}: {fmt(t.from, 0)} → {fmt(t.to, 0)} %
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <OilHowTo />
        )}
      </div>

      {m.location_visible && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold">Трек:</span>
            {[1, 7, 30].map((d) => (
              <button key={d} onClick={() => setRange(d)} className={`rounded-lg px-2 py-1 ${range === d ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}>
                {d === 1 ? 'сутки' : `${d} дн`}
              </button>
            ))}
            <span className="text-xs text-muted-foreground">{track.data?.total ? `точек: ${track.data.total}` : ''}</span>
          </div>
          <MapView track={line} markers={m.position ? [{ id: m.id, lat: m.position.lat, lon: m.position.lon, label: m.name, color: '#10b981' }] : []} height={380} />
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-5">
          <div className="label">Моточасы по дням, 30 дней</div>
          <Bars data={days.map((d: any) => ({ label: d.day, value: d.engine_hours }))} unit="ч" color="#1f6feb" />
        </div>
        <div className="card p-5">
          <div className="label">Пробег по ГНСС по дням, км</div>
          <Bars data={days.map((d: any) => ({ label: d.day, value: d.gnss_km }))} unit="км" color="#10b981" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-3 p-5">
          <h2 className="font-bold">Показание счётчика</h2>
          <p className="text-xs text-muted-foreground">
            Показание с панели — эталон: по нему автоматически калибруются счётчики трекера, платформы и оценка телефона.
          </p>
          <ReadingForm id={id} onDone={reload} />
        </div>
        <div className="card space-y-3 p-5">
          <h2 className="font-bold">Источники данных</h2>
          <SourcesBlock id={id} sources={det.data.sources} canManage={canManage} onChange={reload} />
        </div>
      </div>

      <div className="card space-y-3 p-5">
        <h2 className="font-bold">Обслуживание по моточасам</h2>
        {det.data.avg_daily_hours ? <p className="text-xs text-muted-foreground">Средняя наработка: {fmt(det.data.avg_daily_hours, 1)} ч/сутки</p> : null}
        <ServiceBlock id={id} items={det.data.service} canManage={canManage} onChange={reload} />
      </div>

      {isOwnerAdmin && (
        <div className="card space-y-3 border-warning/40 p-5">
          <h2 className="font-bold">Местоположение этой машины</h2>
          <p className="text-sm text-muted-foreground">
            Решение принимает только главный администратор владельца. Если выключить, сервер перестаёт принимать координаты этой машины: они отбрасываются при
            получении и нигде не сохраняются. Моточасы и пробег по счётчикам продолжают поступать.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={m.location_enabled ? 'btn-danger' : 'btn-primary'}
              onClick={async () => {
                await api('PATCH', `/api/machines/${id}`, { location_enabled: !m.location_enabled });
                reload();
              }}
            >
              {m.location_enabled ? 'Выключить местоположение' : 'Включить местоположение'}
            </button>
            <button
              className="btn-ghost"
              onClick={async () => {
                if (confirm('Удалить всю историю местоположений этой машины? Действие необратимо.')) {
                  await api('DELETE', `/api/machines/${id}/positions`);
                  reload();
                }
              }}
            >
              Удалить историю местоположений
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
