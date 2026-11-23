#!/usr/bin/env bash
# Keeps the free-signed iPhone app from expiring. Free signing lasts 7 days, so once
# fewer than REFRESH_DAYS are left this re-signs the saved copy of the app with a new
# profile and reinstalls it over Wi-Fi or cable. Your songs and settings stay.
#
# It runs from ~/Library/Application Support/prag-music (macOS stops background jobs
# from reading ~/Documents), every 30 minutes, from the LaunchAgent that
# tools/install-auto-refresh.sh sets up. It does nothing unless a refresh is due and
# the iPhone is reachable: Apple only issues a free profile while the phone is
# connected. Manual run: bash "<that folder>/refresh.sh" --force
# (--sign-only re-signs without installing, to test signing; the phone must still be reachable.)
set -uo pipefail

BUNDLE_ID="com.pragalvhasharma.pragmusic"
TEAM_ID="2N7X58QCS7"
REFRESH_DAYS="${REFRESH_DAYS:-3}"
dir="$HOME/Library/Application Support/prag-music"
saved_app="$dir/PragMusic.app"           # copied here by tools/install-iphone.sh
entitlements="$dir/entitlements.plist"
state="$dir/iphone-expires"              # Unix time the installed copy stops opening
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
work="$dir/work"
log() { echo "[$(date '+%Y-%m-%d %H:%M')] $*"; }

now=$(date +%s)
expires=$(cat "$state" 2>/dev/null || echo 0)
left=$(( expires - now ))
mode="${1:-}"
if [ -z "$mode" ] && [ "$left" -gt $(( REFRESH_DAYS * 86400 )) ]; then
  exit 0
fi
[ -d "$saved_app" ] || { log "no saved app; run npm run iphone once from the repo"; exit 1; }

mkdir "$dir/refresh.lock" 2>/dev/null || { log "another refresh is running"; exit 0; }
trap 'rmdir "$dir/refresh.lock"' EXIT

devices_json="$(mktemp)"
xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1
read -r core_id udid < <(python3 - "$devices_json" <<'PY' 2>/dev/null
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    if (d.get("hardwareProperties", {}).get("platform") == "iOS"
            and d.get("connectionProperties", {}).get("tunnelState") != "unavailable"):
        print(d["identifier"], d["hardwareProperties"]["udid"])
        break
PY
)
rm -f "$devices_json"

if [ -z "${core_id:-}" ]; then
  log "iPhone not reachable; $(( left / 3600 ))h of signing left"
  if [ "$expires" -gt 0 ] && [ "$left" -lt 86400 ] && [ -x "$HOME/.local/bin/blocked-alert" ]; then
    "$HOME/.local/bin/blocked-alert" notify \
      "Prag Music iPhone app expires $(date -r "$expires" '+%b %d %H:%M'): unlock the phone on the same Wi-Fi as the Mac" >/dev/null 2>&1 || true
  fi
  exit 0
fi
log "refreshing ($(( left / 3600 ))h left)"

# Xcode keeps using a cached profile until it expires, which would extend nothing.
# Set this app's cached profiles aside, then build the placeholder app with the same
# app ID so Xcode fetches a new 7-day profile.
mkdir -p "$dir/old-profiles"
for f in "$profiles"/*.mobileprovision; do
  [ -e "$f" ] || continue
  if security cms -D -i "$f" 2>/dev/null | grep -q "$TEAM_ID\.$BUNDLE_ID<"; then mv -f "$f" "$dir/old-profiles/"; fi
done
if ! xcodebuild -project "$dir/signer/Signer.xcodeproj" -scheme Signer -configuration Release \
    -destination "id=$udid" -derivedDataPath "$dir/signer/dd" \
    DEVELOPMENT_TEAM="$TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration -quiet build; then
  mv -f "$dir/old-profiles/"*.mobileprovision "$profiles/" 2>/dev/null
  log "could not get a new profile; will retry next run"
  exit 1
fi
profile="$dir/signer/dd/Build/Products/Release-iphoneos/Signer.app/embedded.mobileprovision"

identity=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
[ -n "$identity" ] || { log "no Apple Development signing identity in the keychain"; exit 1; }
mkdir -p "$work"
[ -d "$work/PragMusic.app" ] && mv "$work/PragMusic.app" "$work/old.$$" && find "$work" -maxdepth 1 -name 'old.*' -exec rm -r {} +
cp -R "$saved_app" "$work/PragMusic.app"
app="$work/PragMusic.app"
cp "$profile" "$app/embedded.mobileprovision"
for f in "$app"/Frameworks/*; do
  [ -e "$f" ] || continue
  codesign -f -s "$identity" --timestamp=none "$f" >/dev/null 2>&1 || { log "signing $f failed"; exit 1; }
done
codesign -f -s "$identity" --timestamp=none --entitlements "$entitlements" "$app" >/dev/null 2>&1 \
  || { log "signing the app failed"; exit 1; }
if [ "$mode" = --sign-only ]; then
  codesign --verify --deep --strict "$app" && log "signed OK (profile until $(security cms -D -i "$profile" | plutil -extract ExpirationDate raw -o - -)); not installed"
  exit 0
fi

if ! xcrun devicectl device install app --device "$core_id" "$app" >/dev/null 2>&1; then
  log "install failed (is the phone locked?); will retry next run"
  exit 1
fi
new=$(security cms -D -i "$profile" | plutil -extract ExpirationDate raw -o - -)
date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$new" +%s > "$state"
log "installed; good until $(date -r "$(cat "$state")" '+%Y-%m-%d %H:%M')"
