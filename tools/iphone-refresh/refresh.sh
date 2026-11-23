#!/usr/bin/env bash
# Keeps the free-signed iPhone app from expiring. Free signing lasts 7 days, so once
# fewer than REFRESH_DAYS are left this re-signs the saved copy of the app with a new
# profile and reinstalls it over Wi-Fi or cable. Your songs and settings stay.
#
# It runs from ~/Library/Application Support/prag-music (macOS stops background jobs
# from reading ~/Documents), every 30 minutes, from the LaunchAgent that
# tools/install-auto-refresh.sh sets up. It does nothing unless a refresh is due and
# the iPhone is connected: Apple only issues a free profile while the phone is.
# Manual run: bash "<that folder>/refresh.sh" --force
# (--sign-only gets a profile and re-signs without installing, to test signing.)
set -uo pipefail

BUNDLE_ID="com.pragalvhasharma.pragmusic"
TEAM_ID="2N7X58QCS7"
REFRESH_DAYS="${REFRESH_DAYS:-3}"
dir="$HOME/Library/Application Support/prag-music"
saved_app="$dir/PragMusic.app"           # copied here by tools/install-iphone.sh
entitlements="$dir/entitlements.plist"
state="$dir/iphone-expires"              # Unix time the installed copy stops opening (0 = unknown)
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
work="$dir/work"
alert="$HOME/.local/bin/blocked-alert"
log() { echo "[$(date '+%Y-%m-%d %H:%M')] $*"; }
profile_expiry() {  # Unix time a .mobileprovision expires
  local d
  d="$(security cms -D -i "$1" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null)" || return 1
  date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$d" +%s
}

now=$(date +%s)
expires=$(cat "$state" 2>/dev/null || echo 0)
left=$(( expires - now ))
if [ "$expires" -gt 0 ]; then left_text="$(( left / 3600 ))h of signing left"; else left_text="not installed yet"; fi

# Warns on the phone once the app is close to expiring (or was never installed).
# blocked-alert drops repeats of the same message.
fail() {
  log "$1"
  if [ -x "$alert" ] && { [ "$expires" -eq 0 ] || [ "$left" -lt 86400 ]; }; then
    local when="soon"
    [ "$expires" -gt 0 ] && when="$(date -r "$expires" '+%b %d %H:%M')"
    "$alert" notify "Prag Music iPhone app expires $when and could not renew: $2" >/dev/null 2>&1 || true
  fi
  exit 1
}

mode="${1:-}"
if [ -z "$mode" ] && [ "$left" -gt $(( REFRESH_DAYS * 86400 )) ]; then
  exit 0
fi
[ -d "$saved_app" ] || fail "no saved app; run npm run iphone once from the repo" "run npm run iphone on the Mac"

# A lock left by a killed run is cleared when its process is gone.
lock="$dir/refresh.lock"
if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then log "another refresh is running"; exit 0; fi
echo $$ > "$lock"
trap 'rm -f "$lock"' EXIT

devices_json="$(mktemp)"
xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1
read -r core_id udid < <(python3 - "$devices_json" <<'PY' 2>/dev/null
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hw = d.get("hardwareProperties", {})
    if hw.get("platform") == "iOS" and hw.get("deviceType") == "iPhone" \
            and d.get("connectionProperties", {}).get("tunnelState") != "unavailable":
        print(d["identifier"], hw["udid"])
        break
PY
) || true
rm -f "$devices_json"
# "Listed" is not enough for Xcode to register the phone; it has to answer.
if [ -z "${core_id:-}" ] || ! xcrun devicectl device info details --device "$core_id" >/dev/null 2>&1; then
  log "iPhone not connected; $left_text"
  if [ -x "$alert" ] && [ "$expires" -gt 0 ] && [ "$left" -lt 86400 ]; then
    "$alert" notify "Prag Music iPhone app expires $(date -r "$expires" '+%b %d %H:%M'): unlock the phone on the same Wi-Fi as the Mac" >/dev/null 2>&1 || true
  fi
  exit 0
fi
log "refreshing ($left_text)"

# Xcode keeps using a cached profile until it expires, which would extend nothing.
# Set this app's cached profiles aside, then build the placeholder app with the same
# app ID so Xcode fetches a new 7-day profile. On failure they go back.
mkdir -p "$dir/old-profiles"
for f in "$profiles"/*.mobileprovision; do
  [ -e "$f" ] || continue
  body="$(security cms -D -i "$f" 2>/dev/null)"
  case "$body" in *"$TEAM_ID.$BUNDLE_ID<"*) mv -f "$f" "$dir/old-profiles/" ;; esac
done
if ! xcodebuild -project "$dir/signer/Signer.xcodeproj" -scheme Signer -configuration Release \
    -destination "id=$udid" -derivedDataPath "$dir/signer/dd" \
    DEVELOPMENT_TEAM="$TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration -quiet build; then
  mv -f "$dir/old-profiles/"*.mobileprovision "$profiles/" 2>/dev/null
  fail "could not get a new profile from Apple; will retry next run" "Apple would not issue a new profile (open Xcode, check the Apple ID is signed in)"
fi
profile="$dir/signer/dd/Build/Products/Release-iphoneos/Signer.app/embedded.mobileprovision"
new_expires="$(profile_expiry "$profile")" || fail "new profile unreadable" "new profile unreadable"
# A profile that adds less than a day would only cause a reinstall every 30 minutes.
if [ "$mode" != --sign-only ] && [ "$new_expires" -lt $(( expires + 86400 )) ]; then
  fail "new profile ends $(date -r "$new_expires") and adds no time; not reinstalling" "Apple returned a profile with no extra time"
fi

# Sign with the certificate the profile was issued for.
certs="$(security cms -D -i "$profile" | python3 -c '
import hashlib, plistlib, sys
for c in plistlib.loads(sys.stdin.buffer.read()).get("DeveloperCertificates", []):
    print(hashlib.sha1(c).hexdigest().upper())')"
identity=""
for h in $(security find-identity -v -p codesigning | awk '{print $2}'); do
  case "$certs" in *"$h"*) identity="$h"; break ;; esac
done
[ -n "$identity" ] || fail "no signing certificate in the keychain matches the profile" "signing certificate missing"

[ -e "$saved_app/PlugIns" ] || [ -e "$saved_app/Extensions" ] \
  && fail "the app has extensions, which this job cannot re-sign; use npm run iphone" "the app now needs npm run iphone"
mkdir -p "$work"
[ -d "$work/PragMusic.app" ] && mv "$work/PragMusic.app" "$work/old.$$"
find "$work" -maxdepth 1 -name 'old.*' -exec rm -r {} +
cp -R "$saved_app" "$work/PragMusic.app"
app="$work/PragMusic.app"
cp "$profile" "$app/embedded.mobileprovision"
for f in "$app"/Frameworks/*; do
  [ -e "$f" ] || continue
  codesign -f -s "$identity" --timestamp=none "$f" >/dev/null 2>&1 || fail "signing $f failed" "re-signing failed"
done
codesign -f -s "$identity" --timestamp=none --entitlements "$entitlements" "$app" >/dev/null 2>&1 \
  || fail "signing the app failed" "re-signing failed"
codesign --verify --deep --strict "$app" 2>/dev/null || fail "the re-signed app does not verify" "re-signing failed"
if [ "$mode" = --sign-only ]; then
  log "signed OK, profile good until $(date -r "$new_expires" '+%Y-%m-%d %H:%M'); not installed"
  exit 0
fi

xcrun devicectl device install app --device "$core_id" "$app" >/dev/null 2>&1 \
  || fail "install failed (phone locked?); will retry next run" "install failed, unlock the phone"
echo "$new_expires" > "$state"
log "installed; good until $(date -r "$new_expires" '+%Y-%m-%d %H:%M')"
