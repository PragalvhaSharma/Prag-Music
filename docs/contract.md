# Prag Music data contract

Every part of the project (the Expo app, the Cloudflare Worker in `worker/`, and the ingest scripts in `scripts/`) follows this file. Change it here first.

## Source data (checked in under `data/`)

- `data/core-library.csv`: the 888 songs. Columns: `name,artist,duration_sec,spotify_uri,found_in`. RFC 4180 quoting. The track id is the last segment of `spotify_uri` (for example `3hxIUxnT27p5WcmjGUXNwx`).
- `data/playlists.json`: `{ "playlists": [{ "id", "name", "spotifyUri", "trackIds": [ordered track ids] }] }`. Currently `no-bad-songs` (NO BAD SONGS) and `ye-plus-plus` (ye ++).
- `data/overrides.csv` (optional, written by hand): `track_id,file_path` to force a match.

## R2 bucket layout (bucket name `prag-music`, Worker binding `BUCKET`)

- `library.json`: the manifest below.
- `audio/<trackId>.m4a`: AAC in MP4, 256 kbps, `+faststart` so playback can start before the file finishes downloading.
- `art/<trackId>.jpg`: square cover art, 600x600 JPEG, optional.

## library.json (manifest version 1)

```json
{
  "version": 1,
  "generatedAt": "2026-11-06T22:00:00Z",
  "tracks": [
    {
      "id": "3hxIUxnT27p5WcmjGUXNwx",
      "title": "Shut up My Moms Calling",
      "artist": "Hotel Ugly",
      "album": null,
      "durationSec": 165,
      "spotifyUri": "spotify:track:3hxIUxnT27p5WcmjGUXNwx",
      "audioKey": "audio/3hxIUxnT27p5WcmjGUXNwx.m4a",
      "artKey": "art/3hxIUxnT27p5WcmjGUXNwx.jpg",
      "bytes": 5312345,
      "sha256": "hex of the encoded m4a",
      "bitrateKbps": 256
    }
  ],
  "playlists": [
    { "id": "no-bad-songs", "name": "NO BAD SONGS", "spotifyUri": "spotify:playlist:...", "trackIds": ["..."] }
  ]
}
```

All 888 tracks are always listed. A track that has no audio uploaded yet has `audioKey: null`, `bytes: null`, `sha256: null`, `bitrateKbps: null`; the app shows it greyed out. `artKey` is null when there is no art. `durationSec` comes from the encoded file when present, otherwise from Spotify. `title`/`artist` come from the Spotify CSV (file tags only fill `album`).

## Worker HTTP API

Base URL: `https://prag-music.<account>.workers.dev` (or `http://localhost:8787` under `wrangler dev`).

Auth for reads: `Authorization: Bearer <APP_TOKEN>` header, or `?token=<APP_TOKEN>` query parameter (needed because the iOS audio player and image loader cannot always send headers). Missing or wrong token: `401 {"error":"unauthorized"}`. Compare tokens in constant time.

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/health` | none | `200 {"ok":true}` |
| GET | `/library` | app | R2 `library.json`. `Content-Type: application/json`, `Cache-Control: no-cache`, `ETag`; honours `If-None-Match` with 304. 404 if not uploaded yet. |
| GET, HEAD | `/audio/<trackId>` | app | R2 `audio/<trackId>.m4a`. `Content-Type: audio/mp4`, `Accept-Ranges: bytes`, `Content-Length`, `ETag`, `Cache-Control: private, max-age=31536000, immutable`. Supports `Range: bytes=a-b`, `bytes=a-`, `bytes=-n` with `206` and `Content-Range`; unsatisfiable range gives `416`. 404 if missing. |
| GET, HEAD | `/art/<trackId>` | app | R2 `art/<trackId>.jpg`, `Content-Type: image/jpeg`, same caching. |
| GET | `/admin/objects?prefix=<p>` | admin | `200 {"objects":[{"key","size","etag","sha256"}]}` listing everything (paginate R2 internally). `sha256` comes from R2 custom metadata, may be null. |
| PUT | `/admin/objects/<key>` | admin | Stores the raw body. Optional header `X-Content-SHA256` is saved as custom metadata `sha256`. Keys allowed: `library.json`, `audio/<id>.m4a`, `art/<id>.jpg` where id matches `^[A-Za-z0-9]{22}$`; anything else gives 400. Returns `200 {"key","size","etag"}`. |
| DELETE | `/admin/objects/<key>` | admin | Deletes. `200 {"deleted":"<key>"}`. |

Admin auth: `Authorization: Bearer <ADMIN_TOKEN>` header only. Secrets `APP_TOKEN` and `ADMIN_TOKEN` are Worker secrets (`wrangler secret put`), and `.dev.vars` for local dev. CORS: allow any origin for GET/HEAD with the Authorization header (handy for the web build). Max upload body is 100 MB on the free plan; songs are about 5 to 15 MB.

