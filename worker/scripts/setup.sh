#!/usr/bin/env bash
# First-time (and safe to repeat) Cloudflare setup for the Prag Music Worker.
# Run from anywhere after "npx wrangler login":   bash worker/scripts/setup.sh
#
# What it does: creates the R2 bucket "prag-music" if missing, makes two random
# tokens (or reuses the ones in worker/.secrets.local), deploys the Worker, sets
# APP_TOKEN and ADMIN_TOKEN as Worker secrets, and prints the workers.dev URL.
#
# Optional env: PRAG_APP_TOKEN / PRAG_ADMIN_TOKEN to supply your own tokens,
# ROTATE_TOKENS=1 to ignore .secrets.local and generate fresh ones.
set -euo pipefail

cd "$(dirname "$0")/.."
BUCKET_NAME="prag-music"
SECRETS_FILE=".secrets.local"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
wrangler() { npx --no-install wrangler "$@"; }

command -v openssl >/dev/null || die "openssl is required"
command -v curl >/dev/null || die "curl is required"

if [ ! -x node_modules/.bin/wrangler ]; then
  say "Installing worker dependencies"
  npm install
fi

say "Checking Cloudflare login"
whoami_out=$(wrangler whoami --json 2>/dev/null || true)
if grep -Eq '"loggedIn": *false' <<<"$whoami_out"; then
  die "wrangler is not logged in. Run: cd worker && npx wrangler login"
fi

say "Checking R2 bucket $BUCKET_NAME"
if wrangler r2 bucket info "$BUCKET_NAME" >/dev/null 2>&1; then
  echo "Bucket already exists."
elif create_out=$(wrangler r2 bucket create "$BUCKET_NAME" 2>&1); then
  echo "Created bucket $BUCKET_NAME."
elif grep -qi "already exists" <<<"$create_out"; then
  echo "Bucket already exists."
else
  printf '%s\n' "$create_out" >&2
  die "could not create the R2 bucket. If the error asks you to enable R2, open the Cloudflare dashboard > R2 once, accept the terms, then re-run."
fi

say "Preparing tokens"
existing_app=""
existing_admin=""
if [ -f "$SECRETS_FILE" ] && [ "${ROTATE_TOKENS:-0}" != "1" ]; then
  existing_app=$(sed -n 's/^APP_TOKEN=//p' "$SECRETS_FILE" | head -n 1)
  existing_admin=$(sed -n 's/^ADMIN_TOKEN=//p' "$SECRETS_FILE" | head -n 1)
fi
app_token="${PRAG_APP_TOKEN:-$existing_app}"
admin_token="${PRAG_ADMIN_TOKEN:-$existing_admin}"
[ -n "$app_token" ] || app_token=$(openssl rand -hex 32)
[ -n "$admin_token" ] || admin_token=$(openssl rand -hex 32)
[ "$app_token" != "$admin_token" ] || die "APP_TOKEN and ADMIN_TOKEN must differ"
if [ -n "$existing_app" ] && [ "$app_token" = "$existing_app" ]; then
  echo "Reusing tokens from worker/$SECRETS_FILE (set ROTATE_TOKENS=1 to replace them)."
else
  echo "Using new tokens; they will be saved to worker/$SECRETS_FILE."
fi

write_secrets_file() {
  local old_umask
  old_umask=$(umask)
  umask 077
  {
    echo "# Prag Music Worker secrets. Private and gitignored. Load with: set -a; . worker/.secrets.local; set +a"
    echo "PRAG_MUSIC_URL=$1"
    echo "APP_TOKEN=$app_token"
    echo "ADMIN_TOKEN=$admin_token"
  } >"$SECRETS_FILE"
  umask "$old_umask"
  chmod 600 "$SECRETS_FILE"
}
# Save before uploading, so the file always matches what Cloudflare has.
previous_url=""
if [ -f "$SECRETS_FILE" ]; then
  previous_url=$(sed -n 's/^PRAG_MUSIC_URL=//p' "$SECRETS_FILE" | head -n 1)
fi
write_secrets_file "$previous_url"

say "Deploying the Worker"
deploy_log=$(mktemp)
trap 'rm -f "$deploy_log"' EXIT
wrangler deploy 2>&1 | tee "$deploy_log"
url=$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$deploy_log" | head -n 1 || true)

say "Setting Worker secrets"
printf '%s' "$app_token" | wrangler secret put APP_TOKEN
printf '%s' "$admin_token" | wrangler secret put ADMIN_TOKEN

[ -n "$url" ] || url="$previous_url"
write_secrets_file "$url"

if [ -z "$url" ]; then
  say "Done, but no workers.dev URL was found in the deploy output."
  echo "Enable workers.dev for the Worker in the Cloudflare dashboard, then add PRAG_MUSIC_URL to worker/$SECRETS_FILE."
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
library_status=$(printf 'header = "Authorization: Bearer %s"\n' "$app_token" |
  curl -sS -o /dev/null -w '%{http_code}' -K - "$url/library" || true)
case "$library_status" in
  200) echo "/library -> 200 (manifest is uploaded)" ;;
  404) echo "/library -> 404 (token works; no manifest uploaded yet)" ;;
  000) echo "/library -> no response yet (workers.dev can take a minute to come up)" ;;
  *) echo "/library -> $library_status (secrets can take a few seconds to apply; re-check shortly)" ;;
esac

say "Worker URL: $url"
echo "Tokens are in worker/$SECRETS_FILE (chmod 600)."
# Bake the URL and app key into the Expo app so it opens already connected.
if command -v node >/dev/null 2>&1 && [ -f ../tools/write-env.mjs ]; then
  node ../tools/write-env.mjs
fi
