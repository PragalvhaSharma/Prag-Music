# Prag Music Worker

Cloudflare Worker that serves the private R2 bucket `prag-music` to the app: `library.json`, audio with byte ranges, and cover art, plus an admin API for the ingest scripts. The API is defined in [../docs/contract.md](../docs/contract.md).

## First-time setup

```sh
cd worker
npm install
npx wrangler login          # opens the browser once
bash scripts/setup.sh       # bucket, tokens, deploy, secrets; prints the URL
```

`setup.sh` is safe to re-run. It reuses the tokens in `worker/.secrets.local` (chmod 600, gitignored), which holds `PRAG_MUSIC_URL`, `APP_TOKEN` and `ADMIN_TOKEN`. Use `ROTATE_TOKENS=1 bash scripts/setup.sh` to replace them, or set `PRAG_APP_TOKEN` / `PRAG_ADMIN_TOKEN` to supply your own.

If R2 has never been used on the account, open the Cloudflare dashboard > R2 once and accept the terms first. If you have more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` before running the script.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then edit the two tokens
npm run dev                      # http://localhost:8787, local R2 simulator in .wrangler/
npm test                         # vitest inside the Workers runtime
npm run typecheck
```

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

Behaviour beyond the contract: when `X-Content-SHA256` is sent, R2 also verifies the body against it, and a mismatch returns `400 {"error":"sha256_mismatch"}` without storing anything. Audio and art honour `If-None-Match` (304) and `If-Range`, and `HEAD` with a `Range` returns the 206 headers. Malformed or multi-part ranges are ignored and get the full file (200). If a token secret is unset, every request that needs it is rejected.
