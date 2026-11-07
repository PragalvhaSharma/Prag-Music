# Prag Music Worker

Cloudflare Worker that serves a private Backblaze B2 bucket to the app: `library.json`, audio with byte ranges, and cover art, plus an admin API for the ingest scripts. It talks to B2 through B2's S3-compatible API (`src/storage.ts`), so `wrangler.jsonc` has no bindings; the bucket and its key are Worker secrets. The API is defined in [../docs/contract.md](../docs/contract.md).

## First-time setup

Create a Backblaze account key: B2 web UI > Application Keys > Add a New Application Key, all buckets, read and write (or use the master key). Save it in `worker/.b2.local` (gitignored) and `chmod 600` it:

```sh
B2_MASTER_KEY_ID=...
B2_MASTER_APP_KEY=...
```

Then:

```sh
cd worker
npm install
npx wrangler login          # opens the browser once
bash scripts/setup.sh       # bucket, keys, tokens, deploy, secrets; prints the URL
```

`setup.sh` (via `scripts/b2_provision.py`):

1. creates a private bucket `prag-music-<hex>` with a lifecycle rule that keeps only the latest version of each file (a replaced or deleted file is removed a day later);
2. creates a key `prag-music-worker` limited to that bucket, which is the only B2 key the Worker gets;
3. makes the app and admin tokens;
4. deploys the Worker to workers.dev;
5. uploads the 7 Worker secrets with `wrangler secret bulk`: `APP_TOKEN`, `ADMIN_TOKEN`, `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`;
6. checks `/health` and `/library`, then runs `../tools/write-env.mjs` to write the app's `.env.local`.

Everything is saved in `worker/.secrets.local` (chmod 600, gitignored): `PRAG_MUSIC_URL` plus the 7 secrets. It is safe to re-run; it reuses the bucket, key and tokens from that file. Use `ROTATE_TOKENS=1 bash scripts/setup.sh` to replace the tokens, or set `PRAG_APP_TOKEN` / `PRAG_ADMIN_TOKEN` to supply your own. `B2_MASTER_KEY_ID` / `B2_MASTER_APP_KEY` can also come from the environment instead of `.b2.local`.

If the deploy prints no workers.dev URL, open Cloudflare > Workers & Pages once to pick a workers.dev subdomain, then re-run. If you have more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` before running the script.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then set the two tokens and the five B2_* values
npm run dev                      # http://localhost:8787
npm test                         # vitest inside the Workers runtime, against an in-memory R2 bucket
npm run typecheck
```

`wrangler dev` has no local storage: it reads and writes the real B2 bucket, so `.dev.vars` needs `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID` and `B2_APP_KEY` (copy them from `.secrets.local`) along with `APP_TOKEN` and `ADMIN_TOKEN`. Tests bind a miniflare R2 bucket named `BUCKET` (`vitest.config.ts`); `storageFor(env)` uses R2 when `BUCKET` is bound and B2 otherwise. `test/s3.test.ts` covers the B2 path against a fake S3.

## Usage

```sh
set -a; . ./.secrets.local; set +a

# upload (the ingest scripts do this)
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Content-SHA256: $(shasum -a 256 song.m4a | cut -d' ' -f1)" \
  --data-binary @song.m4a "$PRAG_MUSIC_URL/admin/objects/audio/3hxIUxnT27p5WcmjGUXNwx.m4a"

curl -H "Authorization: Bearer $ADMIN_TOKEN" "$PRAG_MUSIC_URL/admin/objects?prefix=audio/"
curl -H "Authorization: Bearer $APP_TOKEN" "$PRAG_MUSIC_URL/library"
curl -H "Range: bytes=0-1023" "$PRAG_MUSIC_URL/audio/3hxIUxnT27p5WcmjGUXNwx?token=$APP_TOKEN" -o head.bin
```

Upload checks: the Worker signs each B2 upload with the `X-Content-SHA256` value as the payload hash, so B2 itself rejects a body that does not match (`400 sha256_mismatch`). `/admin/objects` returns `sha256: null` on B2, so `ingest.py` compares the MD5 `etag` instead.

Behaviour beyond the contract: audio and art honour `If-None-Match` (304) and `If-Range`, and `HEAD` with a `Range` returns the 206 headers. Malformed or multi-part ranges are ignored and get the full file (200). If a token secret is unset, every request that needs it is rejected; if the B2 secrets are missing, storage requests fail with `500 internal_error`.
