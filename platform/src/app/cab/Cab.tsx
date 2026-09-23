import { useEffect, useRef, useState } from 'react';
import { api, ago } from '../api';
import { ErrorLine } from '../ui';
import { EngineDetector } from './engine';
import * as outbox from './queue';
import { robustDistance, type Fix } from '../../../server/domain/odometry';
import { haversineM as haversine } from '../../../server/domain/geo';

const DEV_KEY = 'itles_device_token';
const CFG_KEY = 'itles_device_cfg';
const HOURS_KEY = 'itles_device_hours';
const ODO_KEY = 'itles_device_odo';

interface Cfg {
  source_id: string;
  machine: { id: string; name: string; category: string; chassis: 'wheeled' | 'tracked'; rotating_upper: boolean };
  location_enabled: boolean;
}

function Pair({ onDone }: { onDone: () => void }) {
  const initial = /code=(\d{6})/.exec(location.hash)?.[1] ?? '';
  const [code, setCode] = useState(initial);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/devices/enroll', { code }, null);
      localStorage.setItem(DEV_KEY, r.token);
      localStorage.setItem(CFG_KEY, JSON.stringify(r.config));
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="dark flex min-h-full items-center justify-center bg-background p-4 text-foreground">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-7 text-center">
        <h1 className="text-xl font-bold">Телефон в кабине</h1>
        <p className="text-sm text-muted-foreground">Введите 6 цифр со страницы машины в кабинете ITles («Источники данных» → «Телефон в кабине»).</p>
        <input
          className="input text-center font-mono text-3xl tracking-[0.4em]"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
        <ErrorLine e={err} />
        <button className="btn-primary w-full" disabled={code.length !== 6}>
          Подключить
        </button>
        <a href="#/" className="block text-xs text-muted-foreground">
          ← Кабинет
        </a>
      </form>
    </div>
  );
}

export function Cab() {
  const [token, setToken] = useState(() => localStorage.getItem(DEV_KEY));
  const [cfg, setCfg] = useState<Cfg | null>(() => JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null'));
  const [active, setActive] = useState(false);
  const [fix, setFix] = useState<GeolocationPosition | null>(null);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [engine, setEngine] = useState(false);
  const [hours, setHours] = useState(() => Number(localStorage.getItem(HOURS_KEY) ?? 0));
  const [reading, setReading] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const det = useRef(new EngineDetector());
  const runStart = useRef<number | null>(null);
  const lastSent = useRef<{ t: number; lat: number; lon: number } | null>(null);
  const odoBuf = useRef<Fix[]>([]);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  // near-real-time: a new record goes out ~3 s after it was captured when there is coverage
  const queue = async (rec: unknown) => {
    await outbox.push(rec);
    if (!soon.current) soon.current = setTimeout(() => { soon.current = null; syncRef.current(); }, 3000);
  };

  const addHours = (until: number) => {
    if (runStart.current === null) return;
    const h = Number(localStorage.getItem(HOURS_KEY) ?? 0) + (until - runStart.current) / 3600e3;
    runStart.current = until;
    localStorage.setItem(HOURS_KEY, String(h));
    setHours(h);
    return h;
  };

  const sync = async () => {
    if (!token) return;
    try {
      const batch = await outbox.peek(1000);
      if (batch.length) {
        const r = await api('POST', '/api/ingest', { records: batch.map((b) => b.rec) }, token);
        await outbox.remove(batch.map((b) => b.key));
        if (r.config) {
          localStorage.setItem(CFG_KEY, JSON.stringify(r.config));
          setCfg(r.config);
        }
      } else {
        const c = await api('GET', '/api/devices/me', undefined, token);
        localStorage.setItem(CFG_KEY, JSON.stringify(c));
        setCfg(c);
      }
      const pending: any[] = JSON.parse(localStorage.getItem('itles_pending_readings') ?? '[]');
      const left: any[] = [];
      for (const rec of pending) {
        try {
          await api('POST', '/api/devices/reading', rec, token);
        } catch (e: any) {
          if (e.status === 0 || e.status >= 500) left.push(rec);
        }
      }
      localStorage.setItem('itles_pending_readings', JSON.stringify(left));
      setLastSync(Date.now());
      setSyncErr(null);
    } catch (e: any) {
      setSyncErr(e.status === 0 ? 'нет связи — данные копятся в телефоне' : e.message);
      if (e.status === 401) {
        localStorage.removeItem(DEV_KEY);
        setToken(null);
      }
    } finally {
      setQueued(await outbox.count());
    }
  };

  syncRef.current = sync;

  useEffect(() => {
    if (!token || !active) return;
    let wake: any = null;
    const lockScreen = async () => {
      try {
        wake = await (navigator as any).wakeLock?.request('screen');
      } catch {
        // not supported: the phone must stay on the charger with screen timeout off
      }
    };
    lockScreen();
    const onVis = () => document.visibilityState === 'visible' && lockScreen();
    document.addEventListener('visibilitychange', onVis);

    const d = det.current;
    d.onChange = async (running, t) => {
      setEngine(running);
      if (running) runStart.current = t;
      const h = running ? Number(localStorage.getItem(HOURS_KEY) ?? 0) : addHours(t);
      if (!running) runStart.current = null;
      await queue({ t, engine_hours: h, engine_hours_method: 'device' });
    };
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (a && a.x !== null && a.y !== null && a.z !== null) d.sample(a.x, a.y, a.z, Date.now());
    };
    addEventListener('devicemotion', onMotion);

    const watch = navigator.geolocation?.watchPosition(
      async (p) => {
        setFix(p);
        setGpsErr(null);
        const c = cfgRef.current;
        const speed = p.coords.speed !== null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null;
        const f: Fix = { t: p.timestamp, lat: p.coords.latitude, lon: p.coords.longitude, speedKmh: speed, accM: p.coords.accuracy };
        if (c && !c.location_enabled) {
          // coordinates never leave the phone: distance is computed here with the same algorithm
          odoBuf.current.push(f);
          if (odoBuf.current.length >= 600) {
            const km = robustDistance(odoBuf.current, { chassis: c.machine.chassis, rotatingUpper: c.machine.rotating_upper, category: c.machine.category }).km;
            const odo = Number(localStorage.getItem(ODO_KEY) ?? 0) + km;
            localStorage.setItem(ODO_KEY, String(odo));
            odoBuf.current = [odoBuf.current.at(-1)!];
            await queue({ t: p.timestamp, odometer_km: odo, odometer_method: 'device' });
          }
          return;
        }
        const prev = lastSent.current;
        // some phones/browsers report no Doppler speed: then displacement decides
        const moved = prev ? haversine(prev.lat, prev.lon, f.lat, f.lon) >= Math.max(20, 2 * (p.coords.accuracy ?? 10)) : true;
        const moving = (speed ?? 0) >= 1.5 || moved;
        const due = !prev || p.timestamp - prev.t >= (moving ? 5_000 : 60_000);
        if (!due) return;
        lastSent.current = { t: p.timestamp, lat: f.lat, lon: f.lon };
        await queue({
          t: p.timestamp,
          lat: f.lat,
          lon: f.lon,
          speed_kmh: speed,
          course: p.coords.heading,
          alt: p.coords.altitude,
          acc_m: p.coords.accuracy,
        });
      },
      (e) => setGpsErr(e.code === 1 ? 'нет разрешения на геолокацию' : 'нет сигнала ГНСС'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );

    const hoursTimer = setInterval(async () => {
      if (det.current.running) {
        const h = addHours(Date.now());
        await queue({ t: Date.now(), engine_hours: h, engine_hours_method: 'device' });
      }
    }, 5 * 60_000);
    const syncTimer = setInterval(sync, 20_000);
    sync();
    return () => {
      removeEventListener('devicemotion', onMotion);
      if (watch !== undefined) navigator.geolocation.clearWatch(watch);
      clearInterval(hoursTimer);
      clearInterval(syncTimer);
      document.removeEventListener('visibilitychange', onVis);
      wake?.release?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, active]);

  if (!token || !cfg) return <Pair onDone={() => { setToken(localStorage.getItem(DEV_KEY)); setCfg(JSON.parse(localStorage.getItem(CFG_KEY) ?? 'null')); }} />;

  const start = async () => {
    const DM: any = (window as any).DeviceMotionEvent;
    if (DM?.requestPermission) await DM.requestPermission().catch(() => {});
    setActive(true);
  };
  const sendReading = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(reading.replace(',', '.'));
    const rec = { id: crypto.randomUUID(), metric: 'engine_hours', value, t: new Date().toISOString() };
    try {
      await api('POST', '/api/devices/reading', rec, token);
      setMsg('Показание сохранено на сервере');
    } catch (err: any) {
      if (err.status === 0) {
        // keep it until coverage returns; the id makes the retry idempotent
        const pending = JSON.parse(localStorage.getItem('itles_pending_readings') ?? '[]');
        localStorage.setItem('itles_pending_readings', JSON.stringify([...pending, rec]));
        setMsg('Нет связи: показание сохранено в телефоне и будет отправлено позже');
      } else setMsg(err.message);
    }
    setReading('');
  };
  const acc = fix?.coords.accuracy;
  return (
    <div className="dark min-h-full bg-background p-4 text-foreground">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Телефон в кабине</div>
            <div className="text-xl font-bold">{cfg.machine.name}</div>
          </div>
          <a href="#/" className="text-xs text-muted-foreground">
            кабинет
          </a>
        </div>
        {!active ? (
          <button onClick={start} className="w-full rounded-2xl bg-primary py-6 text-xl font-bold text-primary-foreground">
            Начать работу
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">Двигатель</div>
              <div className={`text-2xl font-bold ${engine ? 'text-success' : 'text-foreground'}`}>{engine ? 'работает' : 'остановлен'}</div>
              <div className="text-xs text-muted-foreground">вибрация {det.current.lastRms.toFixed(3)}</div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">Работа двигателя (оценка)</div>
              <div className="text-2xl font-bold">≈ {hours.toFixed(1)} ч</div>
              <div className="text-xs text-muted-foreground">калибруется по счётчику</div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">ГНСС</div>
              <div className="text-2xl font-bold">{gpsErr ? '—' : acc ? `±${Math.round(acc)} м` : '…'}</div>
              <div className="text-xs text-muted-foreground">
                {gpsErr ?? (cfg.location_enabled ? 'координаты передаются' : 'местоположение выключено владельцем: считаем только пробег')}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">Очередь отправки</div>
              <div className="text-2xl font-bold">{queued}</div>
              <div className="text-xs text-muted-foreground">{syncErr ?? `отправлено ${ago(lastSync)}`}</div>
            </div>
          </div>
        )}
        <form onSubmit={sendReading} className="space-y-2 rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold">Показание счётчика моточасов</div>
          <input className="input text-lg" inputMode="decimal" placeholder="например 4521,4" value={reading} onChange={(e) => setReading(e.target.value)} required />
          <button className="w-full rounded-xl bg-primary py-3 font-semibold text-primary-foreground">Отправить</button>
          {msg && <div className="text-sm text-foreground">{msg}</div>}
        </form>
        <p className="text-xs text-muted-foreground">
          Держите телефон закреплённым в кабине и на зарядке. Без связи данные хранятся в телефоне и отправятся автоматически.
        </p>
      </div>
    </div>
  );
}
