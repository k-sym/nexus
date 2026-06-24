#!/usr/bin/env bash
# Re-sign nested Mach-O inside a Tauri .app with a Developer ID so notarization
# accepts them. Tauri signs the main executable + app bundle, but the bundled
# Node's .node native modules are adhoc/linker-signed (notarization rejects
# adhoc). We sign inside-out: nested binaries first (with secure timestamps),
# then re-seal the app bundle last.
#
# Usage: scripts/sign-nested-binaries.sh "<path/to/App.app>" "Developer ID Application: … (TEAMID)"
# Requires network (codesign --timestamp contacts Apple's TSA).
set -euo pipefail

APP="${1:?app path required}"
ID="${2:?signing identity required}"
ENT="$(cd "$(dirname "$0")/.." && pwd)/tauri/src-tauri/entitlements.plist"

echo "[sign] bundled node (hardened runtime + JIT entitlements for V8)"
codesign --force --options runtime --timestamp --entitlements "$ENT" \
  --sign "$ID" "$APP/Contents/Resources/node/bin/node"

echo "[sign] every other nested Mach-O (.node / .dylib / .so / extensionless) by type"
# Detect by `file`, not extension — sqlite-vec ships vec0.dylib, others ship .node,
# and some prebuilds are extensionless. Skip the bundled node (signed above with
# entitlements). Libraries get runtime + timestamp (no entitlements needed).
NODE_BIN="$APP/Contents/Resources/node/bin/node"
find "$APP/Contents/Resources" -type f ! -path "$NODE_BIN" -print0 | while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    codesign --force --options runtime --timestamp --sign "$ID" "$f"
    echo "  signed: ${f#"$APP"/}"
  fi
done

echo "[sign] re-seal the app bundle (outside-in finalize, with entitlements)"
codesign --force --options runtime --timestamp --entitlements "$ENT" \
  --sign "$ID" "$APP"

echo "[sign] done"
