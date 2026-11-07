#!/usr/bin/env bash
# First-time (and safe to repeat) setup for the Prag Music Worker on free tiers:
# files in a private Backblaze B2 bucket, the Worker on Cloudflare's workers.dev.
#
#   1. cd worker && npx wrangler login
#   2. Put a Backblaze account key in worker/.b2.local (chmod 600):
#        B2_MASTER_KEY_ID=...
#        B2_MASTER_APP_KEY=...
#   3. bash worker/scripts/setup.sh
#
# It creates the bucket and a key limited to it (or reuses them), makes the app
# and admin tokens (or reuses them), deploys the Worker, uploads its secrets,
# checks /health and /library, and writes the app's .env.local.
# Optional env: PRAG_APP_TOKEN / PRAG_ADMIN_TOKEN, ROTATE_TOKENS=1.
set -euo pipefail

cd "$(dirname "$0")/.."
SECRETS_FILE=".secrets.local"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
wrangler() { npx --no-install wrangler "$@"; }
secret() { sed -n "s/^$1=//p" "$SECRETS_FILE" | head -n 1; }

command -v python3 >/dev/null || die "python3 is required"
command -v curl >/dev/null || die "curl is required"

if [ ! -x node_modules/.bin/wrangler ]; then
  say "Installing worker dependencies"
  npm install
fi

say "Checking Cloudflare login"
if ! whoami_out=$(wrangler whoami --json 2>/dev/null) || grep -Eq '"loggedIn": *false' <<<"$whoami_out"; then
  die "wrangler is not logged in. Run: cd worker && npx wrangler login"
fi

say "Setting up Backblaze B2"
python3 scripts/b2_provision.py provision

say "Deploying the Worker"
deploy_log=$(mktemp)
trap 'rm -f "$deploy_log"' EXIT
wrangler deploy 2>&1 | tee "$deploy_log"
url=$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$deploy_log" | head -n 1 || true)
[ -n "$url" ] || url=$(secret PRAG_MUSIC_URL)
[ -z "$url" ] || python3 scripts/b2_provision.py set-url "$url"

say "Uploading Worker secrets"
python3 scripts/b2_provision.py secrets-json | wrangler secret bulk

if [ -z "$url" ]; then
  say "Done, but no workers.dev URL was found in the deploy output."
  echo "Open Cloudflare > Workers & Pages once to pick a workers.dev subdomain, then re-run this script."
  exit 0
fi

say "Checking $url"
health=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if health=$(curl -fsS "$url/health" 2>/dev/null); then break; fi
  sleep 3
done
echo "/health -> ${health:-no response yet (workers.dev can take a minute to come up)}"
# Pass the token through curl's stdin config so it never appears in the process list.
library_status=""
for _ in 1 2 3 4 5; do
  library_status=$(printf 'header = "Authorization: Bearer %s"\n' "$(secret APP_TOKEN)" |
    curl -sS -o /dev/null -w '%{http_code}' -K - "$url/library" || true)
  case "$library_status" in 200|404) break ;; esac
  sleep 3
done
case "$library_status" in
  200) echo "/library -> 200 (manifest is uploaded)" ;;
  404) echo "/library -> 404 (token and B2 work; no songs uploaded yet)" ;;
  000) echo "/library -> no response yet (workers.dev can take a minute to come up)" ;;
  *) echo "/library -> $library_status (secrets can take a few seconds to apply; re-check shortly)" ;;
esac

say "Worker URL: $url"
echo "Tokens and B2 keys are in worker/$SECRETS_FILE (chmod 600)."
# Bake the URL and app key into the Expo app so it opens already connected.
if command -v node >/dev/null 2>&1 && [ -f ../tools/write-env.mjs ]; then
  node ../tools/write-env.mjs
fi
