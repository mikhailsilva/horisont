// The native app opens straight into the cabinet (app/), not the marketing landing page.
import { cpSync, rmSync, writeFileSync } from 'node:fs';

rmSync('www', { recursive: true, force: true });
cpSync('../../platform/dist', 'www', { recursive: true });
writeFileSync(
  'www/index.html',
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>location.replace("./app/index.html"+location.hash)</script>',
);
console.log('www ready');
