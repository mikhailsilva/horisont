/**
 * Oil sensor registry shared by the API and the UI. Keys are what trackers/gateway send in
 * `sensors: { key: value }`; values are already in engineering units.
 * Sources: engine ECU over J1939 (SPN 98 level, SPN 100 pressure, SPN 175 temperature,
 * SPN 1638 hydraulic temperature), level sensors/switches, oil condition sensors (Modbus/J1939).
 */
export type Status = 'ok' | 'warn' | 'crit';

export interface SensorDef {
  label: string;
  unit: string;
  min: number;
  max: number;
  digits: number;
  // default reference limits; the direction is given by the operator
  warn?: ['<' | '>', number];
  crit?: ['<' | '>', number];
  source: string;
}

export const SENSORS: Record<string, SensorDef> = {
  oil_level_pct: { label: 'Уровень масла', unit: '%', min: 0, max: 100, digits: 0, warn: ['<', 25], crit: ['<', 15], source: 'J1939 SPN 98 или датчик уровня' },
  oil_level_low: { label: 'Масло ниже минимума', unit: '', min: 0, max: 1, digits: 0, crit: ['>', 0.5], source: 'сигнализатор уровня (дискретный вход)' },
  oil_pressure_kpa: { label: 'Давление масла', unit: 'кПа', min: 0, max: 1500, digits: 0, source: 'J1939 SPN 100' },
  oil_temp_c: { label: 'Температура масла', unit: '°C', min: -60, max: 200, digits: 0, warn: ['>', 110], crit: ['>', 125], source: 'J1939 SPN 175 или датчик' },
  hyd_temp_c: { label: 'Температура гидравлики', unit: '°C', min: -60, max: 200, digits: 0, warn: ['>', 80], crit: ['>', 90], source: 'J1939 SPN 1638 или датчик' },
  oil_water_aw: { label: 'Вода в масле (активность)', unit: 'aw', min: 0, max: 1, digits: 2, warn: ['>', 0.5], crit: ['>', 0.8], source: 'датчик состояния масла' },
  oil_water_ppm: { label: 'Вода в масле', unit: 'ppm', min: 0, max: 100000, digits: 0, source: 'датчик состояния масла' },
  oil_visc_cst: { label: 'Вязкость', unit: 'мм²/с', min: 0, max: 5000, digits: 1, source: 'датчик состояния масла' },
  oil_dielectric: { label: 'Диэлектрическая проницаемость', unit: '', min: 1, max: 10, digits: 3, source: 'датчик состояния масла' },
  oil_fe_particles: { label: 'Ферромагнитные частицы', unit: 'шт', min: 0, max: 1e9, digits: 0, source: 'датчик износа' },
};

export function sensorStatus(key: string, value: number): Status | null {
  const d = SENSORS[key];
  if (!d || (!d.warn && !d.crit)) return null;
  const hit = (lim?: ['<' | '>', number]) => !!lim && (lim[0] === '<' ? value < lim[1] : value > lim[1]);
  return hit(d.crit) ? 'crit' : hit(d.warn) ? 'warn' : 'ok';
}

export function worst(statuses: Array<Status | null>): Status | null {
  if (statuses.includes('crit')) return 'crit';
  if (statuses.includes('warn')) return 'warn';
  return statuses.includes('ok') ? 'ok' : null;
}

export interface Pt {
  t: number;
  v: number;
}

export interface LevelAnalysis {
  topups: Array<{ t: number; from: number; to: number }>;
  consumption_pct_per_100h: number | null;
  hours: number | null;
  points: number;
}

/**
 * Oil level analysis. Top-ups are found on a 5-point median (a sump reading jumps with slope and
 * oil in the galleries; a centred median keeps step edges in place): a rise of >= 5 points within
 * 6 h. Consumption is the engine-hour-weighted slope of least-squares lines fitted to the raw
 * readings of each segment between top-ups, so neither the median nor the series edges bias it;
 * the top-up size is the gap between neighbouring lines. Needs >= 20 engine hours in total.
 */
export function analyzeLevel(level: Pt[], hours: Pt[]): LevelAnalysis {
  const pts = [...level].sort((a, b) => a.t - b.t);
  const med = pts.map((p, i) => {
    const w = pts.slice(Math.max(0, i - 2), i + 3).map((x) => x.v).sort((a, b) => a - b);
    return { t: p.t, v: w[w.length >> 1] };
  });
  const cuts: number[] = [];
  for (let i = 1; i < med.length; i++) {
    const rise = med[i].v - med[i - 1].v;
    if (rise >= 5 && med[i].t - med[i - 1].t <= 6 * 3600e3 && !(cuts.length && med[i].t - pts[cuts[cuts.length - 1]].t < 3600e3)) cuts.push(i);
  }

  const hs = [...hours].sort((a, b) => a.t - b.t);
  const hoursAt = (t: number): number | null => {
    if (hs.length < 2 || t < hs[0].t - 12 * 3600e3 || t > hs[hs.length - 1].t + 12 * 3600e3) return null;
    if (t <= hs[0].t) return hs[0].v;
    if (t >= hs[hs.length - 1].t) return hs[hs.length - 1].v;
    let lo = 0;
    let hi = hs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (hs[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = hs[lo];
    const b = hs[hi];
    return b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  };

  const bounds = [0, ...cuts, pts.length];
  const fits: Array<{ slope: number; icpt: number; span: number; h0: number; h1: number } | null> = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const seg = pts.slice(bounds[k], bounds[k + 1]).map((p) => ({ h: hoursAt(p.t), v: p.v })).filter((x): x is { h: number; v: number } => x.h !== null);
    if (seg.length < 3) {
      fits.push(null);
      continue;
    }
    const n = seg.length;
    const mh = seg.reduce((a, x) => a + x.h, 0) / n;
    const mv = seg.reduce((a, x) => a + x.v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const x of seg) {
      sxy += (x.h - mh) * (x.v - mv);
      sxx += (x.h - mh) ** 2;
    }
    const h0 = Math.min(...seg.map((x) => x.h));
    const h1 = Math.max(...seg.map((x) => x.h));
    if (sxx === 0 || h1 - h0 < 2) {
      fits.push(null);
      continue;
    }
    const slope = sxy / sxx;
    fits.push({ slope, icpt: mv - slope * mh, span: h1 - h0, h0, h1 });
  }

  const topups = cuts.map((i, k) => {
    const a = fits[k];
    const b = fits[k + 1];
    const h = hoursAt(pts[i].t);
    if (a && b && h !== null) return { t: pts[i].t, from: a.icpt + a.slope * h, to: b.icpt + b.slope * h };
    return { t: pts[i].t, from: med[i - 1].v, to: med[i].v };
  });

  const good = fits.filter((f): f is NonNullable<typeof f> => !!f);
  const span = good.reduce((a, f) => a + f.span, 0);
  const consumption = span >= 20 ? Math.max(0, (good.reduce((a, f) => a - f.slope * f.span, 0) / span) * 100) : null;
  return { topups, consumption_pct_per_100h: consumption, hours: span >= 20 ? span : null, points: pts.length };
}
