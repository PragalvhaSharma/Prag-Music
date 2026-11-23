#!/usr/bin/env bash
# Builds a Release copy of Prag Music, signs it with the free Personal Team,
# installs it on the iPhone (plugged in, or on the same Wi-Fi once paired) and opens it.
# Free signing lasts 7 days. This also saves a copy of the app to
# ~/Library/Application Support/prag-music so the auto-refresh job
# (tools/install-auto-refresh.sh) can re-sign and reinstall it before then.
# NO_LAUNCH=1 skips opening the app.
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID="${PRAG_TEAM_ID:-2N7X58QCS7}"
BUNDLE_ID="com.pragalvhasharma.pragmusic"

DEVICES_JSON="$(mktemp)"
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null
read -r CORE_ID UDID < <(python3 - "$DEVICES_JSON" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") == "iOS" and d.get("connectionProperties", {}).get("tunnelState") != "unavailable":
        print(d["identifier"], hw["udid"])
        break
PY
)
rm -f "$DEVICES_JSON"
if [ -z "${UDID:-}" ]; then
  echo "No iPhone found. Plug it in, unlock it, and try again." >&2
  exit 1
fi

node tools/write-env.mjs --device
[ -d ios ] || npx expo prebuild --platform ios
[ -d ios/PragMusic.xcworkspace ] || (cd ios && pod install)

xcodebuild -workspace ios/PragMusic.xcworkspace -scheme PragMusic \
  -configuration Release -destination "id=$UDID" -derivedDataPath ios/build/dd \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  -quiet build

xcrun devicectl device install app --device "$CORE_ID" \
  ios/build/dd/Build/Products/Release-iphoneos/PragMusic.app

# Save this build for the auto-refresh job, plus when its signing runs out.
built=ios/build/dd/Build/Products/Release-iphoneos/PragMusic.app
keep="$HOME/Library/Application Support/prag-music"
mkdir -p "$keep"
[ -d "$keep/PragMusic.app" ] && mv "$keep/PragMusic.app" "$keep/PragMusic.app.old.$$"
cp -R "$built" "$keep/PragMusic.app"
find "$keep" -maxdepth 1 -name 'PragMusic.app.old.*' -exec rm -r {} +
codesign -d --entitlements - --xml "$built" > "$keep/entitlements.plist" 2>/dev/null
expiry="$(security cms -D -i "$built/embedded.mobileprovision" | plutil -extract ExpirationDate raw -o - -)"
date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$expiry" +%s > "$keep/iphone-expires"

if [ "${NO_LAUNCH:-0}" = 1 ]; then
  echo "Prag Music is installed on your iPhone."
else
  xcrun devicectl device process launch --device "$CORE_ID" "$BUNDLE_ID"
  echo "Prag Music is installed and open on your iPhone."
fi
