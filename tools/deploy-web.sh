#!/usr/bin/env bash
# Builds the web version of Prag Music and deploys it to Vercel (production).
#
# The site is public, so the build never contains the app key: .env files are not
# loaded, only the Worker address is passed in, and the script stops if the key
# turns up anywhere in the output. Browsers are unlocked once with #key=<APP_TOKEN>
# (see src/lib/config.ts). Usage: npm run deploy:web
#
# It deploys a prebuilt Build Output folder rather than plain files, because Expo puts
# fonts and images under assets/node_modules/ and a normal Vercel upload skips any
# folder named node_modules. Routing lives in web/vercel-output-config.json.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
secrets="$root/worker/.secrets.local"
out="$root/dist"
# .vercel-web/ (gitignored) holds the Vercel project link and the upload folder.
link="$root/.vercel-web"
project="${PRAG_MUSIC_VERCEL_PROJECT:-prag-music}"

[ -f "$secrets" ] || { echo "worker/.secrets.local not found. Run worker/scripts/setup.sh first." >&2; exit 1; }
command -v vercel >/dev/null || { echo "Install the Vercel CLI first: npm i -g vercel" >&2; exit 1; }
server_url="$(sed -n 's/^PRAG_MUSIC_URL=//p' "$secrets" | tr -d '[:space:]')"
app_token="$(sed -n 's/^APP_TOKEN=//p' "$secrets" | tr -d '[:space:]')"
[ -n "$server_url" ] || { echo "PRAG_MUSIC_URL missing from worker/.secrets.local" >&2; exit 1; }
[ -n "$app_token" ] || { echo "APP_TOKEN missing from worker/.secrets.local (needed for the leak check)" >&2; exit 1; }

cd "$root"
echo "[deploy-web] building for $server_url"
env -u EXPO_PUBLIC_PRAG_MUSIC_TOKEN EXPO_NO_DOTENV=1 EXPO_PUBLIC_PRAG_MUSIC_URL="$server_url" \
  npx expo export --platform web --output-dir "$out" --clear

if grep -rqF -- "$app_token" "$out"; then
  echo "[deploy-web] the app key ended up in the build. Not deploying." >&2
  exit 1
fi
stray="$(cd "$out" && find . -name '.*' ! -name '.')"
if [ -n "$stray" ]; then
  echo "[deploy-web] unexpected hidden files in dist/, not deploying:" >&2
  echo "$stray" >&2
  exit 1
fi

if [ ! -f "$link/.vercel/project.json" ]; then
  vercel project inspect "$project" >/dev/null 2>&1 || vercel project add "$project"
  mkdir -p "$link"
  (cd "$link" && vercel link --yes --project "$project")
fi

staged="$link/.vercel/output"
if [ -d "$staged" ]; then mv "$staged" "$link/.vercel/output.old.$$"; fi
mkdir -p "$staged"
cp -R "$out" "$staged/static"
cp "$root/web/vercel-output-config.json" "$staged/config.json"
find "$link/.vercel" -maxdepth 1 -name 'output.old.*' -exec rm -r {} +

(cd "$link" && vercel deploy --prebuilt --prod --yes)
