#!/usr/bin/env bash
#
# Build a signed + notarized + stapled macOS arm64 .dmg of the Tauri Nexus shell,
# end to end. Encodes the recipe verified in Phase 3-4
# (docs/superpowers/specs/2026-06-23-tauri-signing-result.md).
#
# Why a script (not just `tauri build`): Tauri signs the Rust exe + app bundle but
# NOT the bundled Node's nested native modules (they stay adhoc/linker-signed, which
# notarization rejects), and Tauri's own dmg target packages the app BEFORE the
# nested-signing sweep. So we drive the steps in the right order ourselves.
#
# Prerequisites (one-time, see the Phase 3-4 plan):
#   - A "Developer ID Application: …" cert in the login keychain.
#   - A notarytool keychain profile (App Store Connect API key or Apple ID).
#
# Configuration (env vars):
#   APPLE_SIGNING_IDENTITY  (required)  e.g. "Developer ID Application: Name (TEAMID)"
#   NEXUS_NOTARY_PROFILE    (optional)  notarytool --keychain-profile name; default "nexus-notary"
#
# Usage:  APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)" npm run dist:mac
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ID="${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to your 'Developer ID Application: … (TEAMID)' identity}"
PROFILE="${NEXUS_NOTARY_PROFILE:-nexus-notary}"
BUNDLE="tauri/src-tauri/target/release/bundle"
DMG_OUT="$BUNDLE/dmg/Nexus.dmg"

log() { printf '\n\033[1;36m[dist]\033[0m %s\n' "$*"; }

# Notarize a single artifact (zip-if-app) and report Accepted/exit on failure.
notarize() {
  local target="$1" upload="$1"
  if [[ "$target" == *.app ]]; then
    upload="/tmp/nexus-notarize.$$.zip"; rm -f "$upload"
    ditto -c -k --keepParent "$target" "$upload"
  fi
  local logf="/tmp/nexus-notary.$$.log"
  xcrun notarytool submit "$upload" --keychain-profile "$PROFILE" --wait 2>&1 | tee "$logf"
  [[ "$upload" == /tmp/*.zip ]] && rm -f "$upload"
  if ! grep -q "status: Accepted" "$logf"; then
    local sid; sid=$(grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' "$logf" | head -1)
    log "NOTARIZATION FAILED — fetching log for $sid"
    xcrun notarytool log "$sid" --keychain-profile "$PROFILE" || true
    exit 1
  fi
}

log "1/6 Build + sign the app (runs prepackage: build, stage, prune, fetch-node)"
APPLE_SIGNING_IDENTITY="$ID" npm run tauri:build

APP="$(find "$BUNDLE/macos" -maxdepth 1 -name '*.app' | head -1)"
[[ -n "$APP" && -d "$APP" ]] || { log "no .app found under $BUNDLE/macos"; exit 1; }
log "app: $APP"

log "2/6 Sign nested Mach-O (bundled node + .node/.dylib — Tauri doesn't)"
bash scripts/sign-nested-binaries.sh "$APP" "$ID"
codesign --verify --deep --strict "$APP"
log "app signature verified (deep)"

log "3/6 Notarize + staple the app"
notarize "$APP"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

log "4/6 Build the dmg around the notarized app"
STAGE="$(mktemp -d)"; cp -R "$APP" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
mkdir -p "$(dirname "$DMG_OUT")"; rm -f "$DMG_OUT"
hdiutil create -volname "Nexus" -srcfolder "$STAGE" -ov -format UDZO "$DMG_OUT"
rm -rf "$STAGE"

log "5/6 Sign + notarize + staple the dmg"
codesign --force --timestamp --sign "$ID" "$DMG_OUT"
notarize "$DMG_OUT"
xcrun stapler staple "$DMG_OUT"
xcrun stapler validate "$DMG_OUT"

log "6/6 Verify Gatekeeper acceptance"
spctl --assess --type execute --verbose=2 "$APP" || true
spctl -a -t open --context context:primary-signature -v "$DMG_OUT" || true

log "DONE → $DMG_OUT ($(du -h "$DMG_OUT" | cut -f1))"
