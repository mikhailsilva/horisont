import { useEffect, useMemo, useState } from 'react';
import type { Me } from '../main';
import { go } from '../main';
import { api, CATEGORY_RU, fmt, METHOD_RU } from '../api';
import { ErrorLine, Fresh, MapView, Modal, useAsync, type MapMarker } from '../ui';
import { StatusDot, fmtSensor } from '../oil';

export function CounterCell({ c, unit }: { c: any; unit: string }) {
  if (!c) return <span className="text-muted-foreground">—</span>;
  return (
    <div>
      <div className="font-semibold tabular-nums">
        {c.exact ? '' : '≈ '}
        {fmt(c.value, unit === 'ч' ? 1 : 1)} {unit}
      </div>
      <div className="text-[11px] text-muted-foreground">{METHOD_RU[c.method] ?? c.method}</div>
    </div>
  );
}

export function AddMachine({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: (id: string) => void }) {
  const orgs = useAsync(() => api('GET', '/api/orgs'), []);
  const customers = (orgs.data?.orgs ?? []).filter((o: any) => o.kind === 'customer');
  const [f, setF] = useState<any>({ category: 'harvester', chassis: 'wheeled', rotating_upper: false });
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!f.org_id && customers.length) setF((x: any) => ({ ...x, org_id: me.org_kind === 'customer' ? me.org_id : customers[0].id }));
  }, [customers.length]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/machines', { ...f, year: f.year ? Number(f.year) : null });
      onDone(r.machine.id);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal title="Новая машина" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {me.org_kind !== 'customer' && (
          <div>
            <label className="label">Клиент (владелец техники)</label>
            <select className="input" value={f.org_id ?? ''} onChange={(e) => setF({ ...f, org_id: e.target.value })}>
              {customers.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label">Название / гаражный номер</label>
          <input className="input" required value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Тип</label>
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, rotating_upper: e.target.value === 'excavator' || e.target.value === 'crane' ? f.rotating_upper : false })}>
              {Object.entries(CATEGORY_RU).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Ходовая</label>
            <select className="input" value={f.chassis} onChange={(e) => setF({ ...f, chassis: e.target.value })}>
              <option value="wheeled">колёсная</option>
              <option value="tracked">гусеничная</option>
            </select>
          </div>
          <input className="input" placeholder="Марка" value={f.make ?? ''} onChange={(e) => setF({ ...f, make: e.target.value })} />
          <input className="input" placeholder="Модель" value={f.model ?? ''} onChange={(e) => setF({ ...f, model: e.target.value })} />
          <input className="input" placeholder="Год выпуска" inputMode="numeric" value={f.year ?? ''} onChange={(e) => setF({ ...f, year: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.rotating_upper} onChange={(e) => setF({ ...f, rotating_upper: e.target.checked })} /> поворотная платформа
          </label>
        </div>
        <ErrorLine e={err} />
        <button className="btn-primary w-full">Добавить</button>
      </form>
    </Modal>
  );
}

export function Fleet({ me }: { me: Me }) {
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const res = useAsync(() => api('GET', '/api/machines'), [tick]);
  useEffect(() => {
    const t = setInterval(async () => {
      await api('POST', '/api/refresh').catch(() => {});
      setTick((x) => x + 1);
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  const machines: any[] = res.data?.machines ?? [];
  const shown = machines.filter((m) => !q || `${m.name} ${m.org_name} ${m.make ?? ''} ${m.model ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const markers: MapMarker[] = useMemo(
    () =>
      shown
        .filter((m) => m.position)
        .map((m) => ({
          id: m.id,
          lat: m.position.lat,
          lon: m.position.lon,
          label: `${m.name} · ${fmt(m.engine_hours?.value)} ч`,
          color: m.freshness === 'online' ? '#22c55e' : m.freshness === 'recent' ? '#f59e0b' : '#ef4444',
        })),
    [res.data, q],
  );
  const online = machines.filter((m) => m.freshness === 'online').length;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Парк техники</h1>
          <p className="text-sm text-muted-foreground">
            {machines.length} машин · на связи {online} · обновление каждые 30 с
          </p>
        </div>
        <div className="flex gap-2">
          <input className="input w-48" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
          {me.role === 'admin' && (
            <button className="btn-primary" onClick={() => setAdding(true)}>
              + Машина
            </button>
          )}
        </div>
      </div>
      <ErrorLine e={res.error} />
      {markers.length > 0 && <MapView markers={markers} height={360} onPick={(id) => go('#/machine/' + id)} />}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Машина</th>
              {me.org_kind !== 'customer' && <th className="px-4 py-3">Клиент</th>}
              <th className="px-4 py-3">Моточасы</th>
              <th className="px-4 py-3">Пробег</th>
              <th className="px-4 py-3">Масло</th>
              <th className="px-4 py-3">Местоположение</th>
              <th className="px-4 py-3">Данные</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-accent" onClick={() => go('#/machine/' + m.id)}>
                <td className="px-4 py-3">
                  <div className="font-semibold">{m.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {CATEGORY_RU[m.category] ?? m.category} {m.make ? '· ' + m.make : ''} {m.model ?? ''}
                  </div>
                </td>
                {me.org_kind !== 'customer' && <td className="px-4 py-3 text-muted-foreground">{m.org_name}</td>}
                <td className="px-4 py-3">
                  <CounterCell c={m.engine_hours} unit="ч" />
                </td>
                <td className="px-4 py-3">
                  <CounterCell c={m.odometer} unit="км" />
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {m.oil ? (
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot s={m.oil.status} />
                      {m.oil.values.oil_level_pct ? fmtSensor('oil_level_pct', m.oil.values.oil_level_pct.value) : 'есть данные'}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {!m.location_enabled ? (
                    <span className="badge bg-muted text-muted-foreground">выключено владельцем</span>
                  ) : !m.location_visible ? (
                    <span className="badge bg-muted text-muted-foreground">скрыто владельцем</span>
                  ) : m.position ? (
                    `${m.position.lat.toFixed(5)}, ${m.position.lon.toFixed(5)}`
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3">
                  <Fresh f={m.freshness} t={m.last_data_t} />
                </td>
              </tr>
            ))}
            {!res.loading && shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  Машин пока нет. {me.role === 'admin' ? 'Добавьте первую кнопкой «+ Машина» или подключите платформу в разделе «Подключения».' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && <AddMachine me={me} onClose={() => setAdding(false)} onDone={(id) => go('#/machine/' + id)} />}
    </div>
  );
}
