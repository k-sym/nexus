# Phases 3 & 4 — Sign, Notarize, DMG: Result

**Date:** 2026-06-24
**Phases:** 3 (sign + notarize) and 4 (dmg) of the full Tauri conversion
**Outcome:** ✅ a **Developer ID-signed, notarized, stapled, Gatekeeper-accepted** arm64
`Nexus.dmg` (239 MB) wrapping a notarized `Nexus (Tauri).app` (522 MB).

## What was done

- **Identity:** `Developer ID Application: Keith Symmonds (CP2LXQW34P)` (created in Task 1).
- **Notarization:** App Store Connect API key stored as the `nexus-notary` keychain profile
  (`xcrun notarytool`). Credentials are local-only — never committed.
- **Foreign-arch prune** (`scripts/prune-foreign-natives.cjs`, wired into `prepackage`):
  `@earendil-works/pi-tui` ships win32 + darwin-x64 + linux prebuilds; those non-arm64
  Mach-O/PE binaries make `codesign`/notarization fail, so they're pruned. Universal
  binaries (which include arm64) are kept.
- **Signing:** `tauri build` (with `APPLE_SIGNING_IDENTITY`) signs the Rust executable +
  app bundle with hardened runtime + entitlements. It does **not** sign nested
  `resources/`, so `scripts/sign-nested-binaries.sh` signs every nested Mach-O
  (the bundled `node` with JIT entitlements; all `.node`/`.dylib` by `file`-detected
  type, with secure timestamps), then re-seals the app.
- **Entitlements:** hardened runtime + `allow-jit` / `allow-unsigned-executable-memory`
  (WebKit JavaScriptCore **and** bundled-Node V8 both JIT), `disable-library-validation`
  (load the differently-signed native modules), `allow-dyld-environment-variables`.
- **DMG:** built around the *already-notarized* `.app` via `hdiutil` (Tauri's own dmg
  target repackages during the build, before the nested-signing sweep, so it would ship
  an app that fails notarization). Signed → notarized → stapled.

## Two notarization rejections that taught the recipe

Apple's notary scanner is the authoritative oracle — it scans **every** Mach-O:
1. First reject: `.node` modules were `adhoc, linker-signed` → notarization needs a real
   Developer ID signature + secure timestamp. Fixed by the nested-signing sweep.
2. Second reject: `sqlite-vec/vec0.dylib` — a **`.dylib`**, missed by an extension-based
   (`*.node`) loop. Fixed by detecting Mach-O via `file` (catches `.dylib`/`.so`/
   extensionless), not by extension.

## Verification (all ✅)

- `codesign --verify --deep --strict` → exit 0; authority chain `Developer ID
  Application → Developer ID CA → Apple Root CA`; `flags=…(runtime)`.
- Zero adhoc Mach-O remain under `Resources/`.
- App: notarization **Accepted**, stapled, `spctl --assess --type execute` → `accepted,
  source=Notarized Developer ID`.
- DMG: notarization **Accepted**, stapled, `spctl -a -t open` → `accepted`.
- App launches under hardened runtime with **no crash** (Gatekeeper allowed it).
- **Native-module load proof:** the signed bundled `node` (carrying the hardened-runtime
  flag) loaded `better-sqlite3` + `sqlite-vec` (dlopen of the signed `vec0.dylib`)
  successfully — confirming `disable-library-validation` + same-Team signing let the
  native modules load under hardened runtime. (Verified in isolation because dev-mode
  tsx services occupied the ports, so the launched app reused them rather than spawning
  its own; the full bundled-Node spawn was already proven unsigned in the spike's Task 9.)

## Follow-ups (Phase 5 / 6)

- **Automate the pipeline (Phase 5):** the current flow is manual — `tauri build` →
  `sign-nested-binaries.sh` → notarize → staple → hdiutil dmg → notarize → staple.
  Fold this into a single `npm run dist` (a Tauri signing hook or a wrapper script) so
  it isn't hand-run.
- **Re-confirm full bundled-Node spawn** end-to-end on a machine with clear ports (the
  isolated native-load proof + unsigned spawn proof cover it, but a single clean
  end-to-end is worth one check).
- **Rename (Phase 6):** `productName "Nexus (Tauri)"` / `identifier it.resolve.nexus.tauri`
  should become `Nexus` / `it.resolve.nexus` when Tauri takes over as the canonical app.
- DMG is currently a plain `hdiutil` volume (app + /Applications symlink); a background
  image / window layout is optional polish.
- Credential setup (cert + notarytool profile) is local to this machine, not in git.
