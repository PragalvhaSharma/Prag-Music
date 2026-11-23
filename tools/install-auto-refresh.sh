#!/usr/bin/env bash
# Sets up the background job that keeps the iPhone app from expiring (free signing
# lasts 7 days). Copies tools/iphone-refresh/ to ~/Library/Application Support/prag-music,
# since macOS blocks background jobs from ~/Documents, and installs a LaunchAgent that
# runs refresh.sh every 30 minutes. Rerun after changing tools/iphone-refresh/.
# --remove takes it out again. Log: ~/Library/Logs/prag-music-refresh.log
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$HOME/Library/Application Support/prag-music"
label="com.pragalvhasharma.pragmusic.refresh"
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
if [ "${1:-}" = --remove ]; then
  rm -f "$plist"
  echo "Auto-refresh removed."
  exit 0
fi
command -v xcodegen >/dev/null || { echo "Install xcodegen first: brew install xcodegen" >&2; exit 1; }

mkdir -p "$dir/signer/Sources" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$root/tools/iphone-refresh/refresh.sh" "$dir/refresh.sh"
cp "$root/tools/iphone-refresh/signer/project.yml" "$dir/signer/"
cp "$root/tools/iphone-refresh/signer/Sources/main.swift" "$dir/signer/Sources/"
(cd "$dir/signer" && xcodegen generate --quiet)
[ -d "$dir/PragMusic.app" ] || echo "Note: run npm run iphone once so there is an app copy to refresh."

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$dir/refresh.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string></dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/prag-music-refresh.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/prag-music-refresh.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Auto-refresh installed: checks every 30 minutes, log at ~/Library/Logs/prag-music-refresh.log"
