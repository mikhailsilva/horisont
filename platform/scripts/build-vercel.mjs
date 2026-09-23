// Produces .vercel/output (Build Output API v3): static UI + one bundled Node function + cron.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = '.vercel/output';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/static`, { recursive: true });
cpSync('dist', `${out}/static`, { recursive: true });
if (existsSync('downloads')) cpSync('downloads', `${out}/static/downloads`, { recursive: true });

const fn = `${out}/functions/api/index.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ['api/node.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: `${fn}/index.mjs`,
  external: ['@electric-sql/pglite', 'pg-native'],
  // pg is CommonJS and requires node built-ins at runtime
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
});
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: 'module' }));
writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }),
);
writeFileSync(
  `${out}/config.json`,
  JSON.stringify({
    version: 3,
    routes: [{ src: '^/api/(.*)$', dest: '/api/index' }, { handle: 'filesystem' }],
    crons: [{ path: '/api/cron/daily', schedule: '0 3 * * *' }],
  }),
);
console.log('vercel output ready');
