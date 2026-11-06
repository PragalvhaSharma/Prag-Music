// Builds src/data/seed-library.json from data/core-library.csv and data/playlists.json.
// The seed lets the app show the full library before the Worker has any audio.
// Run: npm run seed
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const [header, ...rows] = parseCsv(readFileSync(join(root, 'data/core-library.csv'), 'utf8'));
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const tracks = rows.map((r) => {
  const spotifyUri = r[col.spotify_uri];
  return {
    id: spotifyUri.split(':').pop(),
    title: r[col.name],
    artist: r[col.artist],
    album: null,
    durationSec: Number(r[col.duration_sec]) || 0,
    spotifyUri,
    audioKey: null,
    artKey: null,
    bytes: null,
    sha256: null,
    bitrateKbps: null,
  };
});
const { playlists } = JSON.parse(readFileSync(join(root, 'data/playlists.json'), 'utf8'));
const out = { version: 1, generatedAt: new Date(0).toISOString(), tracks, playlists };
const dest = join(root, 'src/data/seed-library.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out));
console.log(`seed: ${tracks.length} tracks, ${playlists.length} playlists -> src/data/seed-library.json`);

