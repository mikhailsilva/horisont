// Read-only check of the АвтоГРАФ.WEB connector against a live server; prints counts only, never credentials.
// Usage: AUTOGRAPH_URL=https://demo.tk-nav.com AUTOGRAPH_USER=demo AUTOGRAPH_PASSWORD=demo tsx scripts/autograph-check.ts [--history-from ISO]
import { autographUnits } from '../server/connectors/autograph.js';

const baseUrl = process.env.AUTOGRAPH_URL;
const username = process.env.AUTOGRAPH_USER;
const password = process.env.AUTOGRAPH_PASSWORD;
if (!baseUrl || !username || !password) throw new Error('Set AUTOGRAPH_URL, AUTOGRAPH_USER and AUTOGRAPH_PASSWORD');
const i = process.argv.indexOf('--history-from');
const historyFrom = i > 0 ? new Date(process.argv[i + 1]) : undefined;

const started = Date.now();
const units = await autographUnits({ baseUrl, username, password }, historyFrom);
const withPos = units.filter((u) => u.records.some((r) => r.lat != null));
const withHours = units.filter((u) => u.records.some((r) => r.engine_hours != null));
const withSensors = units.filter((u) => u.records.some((r) => r.sensors));
console.log(
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      server: new URL(baseUrl).host,
      units: units.length,
      units_with_position: withPos.length,
      units_with_engine_hours: withHours.length,
      units_with_sensors: withSensors.length,
      records: units.reduce((n, u) => n + u.records.length, 0),
      elapsed_ms: Date.now() - started,
      sample: withPos.slice(0, 3).map((u) => ({ name: u.name, last: u.records.filter((r) => r.lat != null).at(-1) })),
    },
    null,
    2,
  ),
);
