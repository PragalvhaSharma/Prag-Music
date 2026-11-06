#!/usr/bin/env node
// Copies the Worker URL and app key from worker/.secrets.local into .env.local,
// so Expo bakes them into the app and it opens already connected (no login screen).
// Runs automatically before `npm start`, `npm run ios` and `npm run ios:release`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// --device: the build goes onto the iPhone, so it must point at the real Cloudflare server.
const forDevice = process.argv.includes('--device');
const isLocal = (url) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);
function fail(message) {
  console.error(`[prag-music] ${message}`);
  process.exit(1);
}
const secretsPath = join(root, 'worker', '.secrets.local');
const envPath = join(root, '.env.local');

if (!existsSync(secretsPath)) {
  const msg = 'worker/.secrets.local not found. Run: cd worker && npx wrangler login && bash scripts/setup.sh';
  if (forDevice) fail(msg);
  if (!existsSync(envPath)) console.warn(`[prag-music] ${msg} (the app will have no music server)`);
  process.exit(0);
}

const vars = {};
for (const line of readFileSync(secretsPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) vars[m[1]] = m[2].trim();
}
if (!vars.PRAG_MUSIC_URL || !vars.APP_TOKEN) {
  const msg = 'worker/.secrets.local is missing PRAG_MUSIC_URL or APP_TOKEN. Re-run worker/scripts/setup.sh.';
  if (forDevice) fail(msg);
  console.warn(`[prag-music] ${msg}`);
  process.exit(0);
}
if (forDevice && isLocal(vars.PRAG_MUSIC_URL)) {
  fail(`PRAG_MUSIC_URL is ${vars.PRAG_MUSIC_URL}, which the iPhone cannot reach. Use the workers.dev URL.`);
}

const body =
  '# Written by tools/write-env.mjs from worker/.secrets.local. Gitignored.\n' +
  `EXPO_PUBLIC_PRAG_MUSIC_URL=${vars.PRAG_MUSIC_URL}\n` +
  `EXPO_PUBLIC_PRAG_MUSIC_TOKEN=${vars.APP_TOKEN}\n`;
const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
if (current !== body) {
  writeFileSync(envPath, body, { mode: 0o600 });
  console.log('[prag-music] .env.local updated with the music server address.');
}
