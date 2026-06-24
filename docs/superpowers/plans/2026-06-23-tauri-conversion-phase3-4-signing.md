# Tauri Conversion — Phases 3 & 4: Sign, Notarize, DMG — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`). **NOTE: this is credential- and tool-driven, not TDD. "Tests" are real `codesign` / `spctl` / `notarytool` / `stapler` invocations with explicit expected output. Task 1 is maintainer-driven (Apple account). Notarization requires network + the maintainer's Apple credentials as env vars (never commit them).**

**Goal:** Produce a **signed, notarized, stapled, distributable arm64 `.dmg`** of the Tauri Nexus shell that launches through Gatekeeper with no prompts and runs its bundled-Node services correctly.

**Architecture:** Use a Developer ID Application identity + Tauri's built-in macOS signing/notarization (`tauri build` with signing config + notarization env vars). Prune foreign-arch native modules from the staged services first (only arm64 darwin Mach-O may ship). Sign all nested binaries (the bundled `node` with JIT entitlements, the `.node` modules), notarize the `.app`, then build/sign/notarize/staple the `.dmg`.

**Tech Stack:** Tauri v2 bundler, `codesign`, `xcrun notarytool`, `xcrun stapler`, `spctl`, macOS Developer ID Application cert, the existing `.stage/` pipeline.

## Global Constraints

From `docs/superpowers/specs/2026-06-23-tauri-full-conversion-design.md` (§2, §4 Phase 3–4):

- **macOS arm64 only.** Developer ID distribution (NOT Mac App Store). **No auto-update.**
- **Electron stays intact** until Phase 6 — do not modify `electron/` or remove it here.
- **Never commit credentials.** Apple ID, app-specific password, API keys, and `.p12` files stay out of git; pass via env vars or the keychain. Add any local creds file to `.gitignore`.
- **Keep the working unsigned dev flow** (`npm run tauri:dev`) functional throughout.
- **The bundled Node and its `.node` modules are arm64 darwin** — foreign-arch prebuilds (win32, darwin-x64) must be pruned, not shipped.
- **Hardened runtime ON**; keep `allow-jit` + `allow-unsigned-executable-memory` (WebKit JSC + Node V8 both JIT) + `disable-library-validation` (load differently-signed `.node`) + `allow-dyld-environment-variables` (bundled Node child).
- Work on branch `feat/tauri-full-conversion`. Commit after each task (except credential material).

> **Tauri v2 signing caveat:** exact config keys / env-var names (`bundle.macOS.signingIdentity`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` vs `APPLE_API_KEY`/`APPLE_API_ISSUER`, whether `tauri build` signs nested `resources` deeply) must be confirmed against the installed `@tauri-apps/cli` 2.x docs. Where a step's behaviour is uncertain (esp. nested-binary signing), the plan verifies empirically with `codesign --verify --deep` / `spctl` and adds an explicit signing sweep if Tauri didn't cover it.

---

## File structure

```
tauri/src-tauri/tauri.conf.json     # add dmg target + macOS signingIdentity/minimumSystemVersion
tauri/src-tauri/entitlements.plist  # fix misleading comment; keep the (needed) entitlements
scripts/prune-foreign-natives.cjs   # NEW: prune non-arm64-darwin .node prebuilds from .stage (Task 2)
scripts/sign-nested-binaries.sh     # NEW (only if Task 4 shows Tauri didn't sign them): codesign sweep
docs/superpowers/specs/2026-06-23-tauri-signing-result.md  # result (Task 7)
.gitignore                          # ensure cred material is ignored
```

---

## Task 1: Create the Developer ID Application identity + notarization credentials (maintainer-driven)

**Files:** none committed (credential setup).

**Interfaces:**
- Produces: a `Developer ID Application: <name> (<TEAMID>)` cert in the login keychain, and notarization credentials stored for `notarytool` — consumed by Tasks 3–6.

- [ ] **Step 1: Create the Developer ID Application certificate**

In Xcode → Settings → Accounts → your Apple ID → Manage Certificates → ＋ → **Developer ID Application** (or via the Apple Developer portal → Certificates → Developer ID Application, then download + double-click to install). This requires the account to be the Team Agent/Admin.
Verify:
```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```
Expected: a line like `… "Developer ID Application: Keith Symmonds (TEAMID)"`. Record the identity string + the 10-char Team ID.

- [ ] **Step 2: Create notarization credentials and store them with notarytool**

Recommended: an **App Store Connect API key** (Keys → ＋, role: Developer; download the `.p8` ONCE). Then store a notarytool profile:
```bash
xcrun notarytool store-credentials "nexus-notary" \
  --key /path/to/AuthKey_XXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_UUID>
```
(Alternative: Apple ID + app-specific password from appleid.apple.com → `--apple-id <id> --team-id <TEAMID> --password <app-specific>`.)
Verify the profile works:
```bash
xcrun notarytool history --keychain-profile "nexus-notary"
```
Expected: returns (an empty or populated) history without an auth error. Move the `.p8` outside the repo.

- [ ] **Step 3: Record the identity + profile name for later tasks**

Note the signing identity string and the `nexus-notary` profile name. No commit (no secrets in git).

---

## Task 2: Prune foreign-arch native modules from the staged services

**Files:**
- Create: `scripts/prune-foreign-natives.cjs`
- Modify: `package.json` (run it in `prepackage`, after `stage:services`)

**Interfaces:**
- Consumes: `.stage/services` (from `stage:services`).
- Produces: a `.stage/services` tree containing only arm64-darwin `.node` binaries — no `win32-*`, no `darwin-x64`, no `linux-*` prebuilds. Required for codesign/notarization to succeed.

- [ ] **Step 1: Identify the foreign binaries**

Run:
```bash
find .stage/services -type f -name '*.node' | xargs -I{} sh -c 'echo "$(file -b "{}" | cut -c1-40)  {}"'
```
Expected: most are `Mach-O 64-bit … arm64`; the offenders are PE32+ (win32) and `Mach-O … x86_64` (darwin-x64) under `@earendil-works/pi-tui/native/{win32,darwin}/prebuilds/...`. Record the directory patterns.

- [ ] **Step 2: Write the prune script**

`scripts/prune-foreign-natives.cjs` — walk `.stage/services`, delete any file whose path matches a non-(darwin-arm64) prebuild dir (`win32-*`, `*-x64`, `linux-*`, `*ia32*`) OR any `*.node` that `file` reports as not `arm64`. Log each removal. Idempotent. Mirror the style of `scripts/stage-services.cjs` (the node-pty prune there is the precedent).
```js
#!/usr/bin/env node
// Remove non-(macOS arm64) native artifacts from .stage/services so codesign
// and notarization don't choke on foreign Mach-O / PE binaries. macOS arm64 build only.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const SERVICES = path.join(ROOT, '.stage', 'services');
const FOREIGN_DIR = /(win32|linux|android)[-/]|darwin-x64|[-/]x64[-/]|ia32/i;
let removed = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (FOREIGN_DIR.test(p + '/')) { fs.rmSync(p, { recursive: true, force: true }); removed++; console.log('[prune] dir', path.relative(ROOT, p)); continue; }
      walk(p);
    } else if (e.isFile() && p.endsWith('.node')) {
      const desc = execFileSync('file', ['-b', p], { encoding: 'utf8' });
      if (!/arm64/.test(desc) || /x86_64|PE32|ELF/.test(desc)) { fs.rmSync(p, { force: true }); removed++; console.log('[prune] file', path.relative(ROOT, p), '—', desc.trim().slice(0,30)); }
    }
  }
}
if (fs.existsSync(SERVICES)) walk(SERVICES);
console.log(`[prune] removed ${removed} foreign native artifact(s)`);
```

- [ ] **Step 3: Wire it into prepackage + run**

In root `package.json`, change `prepackage` to run the prune after staging, e.g.:
`"prepackage": "npm run build && npm run stage:services && node scripts/prune-foreign-natives.cjs && npm run stage:node"`.
Run `npm run prepackage`, then re-run the Step-1 `find` command. Expected: every remaining `.node` is `Mach-O … arm64`; zero win32/x64 entries.

- [ ] **Step 4: Sanity — services still boot after prune**

Quick check that pruning didn't remove a needed arm64 module: launch the (unsigned) packaged app or `node .stage/services/backend/dist/index.js` and confirm `:4173/api/health` → 200. (pi-tui's win32/x64 prebuilds are not used on macOS arm64, so removing them is safe.)

- [ ] **Step 5: Commit**

```bash
git add scripts/prune-foreign-natives.cjs package.json
git commit -m "build(tauri): prune foreign-arch native modules from staging for signing"
```

---

## Task 3: Configure Tauri macOS signing + produce a signed (pre-notarization) .app

**Files:**
- Modify: `tauri/src-tauri/tauri.conf.json` (macOS signing config), `tauri/src-tauri/entitlements.plist` (comment fix)

**Interfaces:**
- Consumes: the Developer ID identity (Task 1), the pruned stage (Task 2).
- Produces: a hardened-runtime, Developer-ID-signed `.app` (not yet notarized) that passes `codesign --verify`.

- [ ] **Step 1: Fix the entitlements comment (keep the entitlements)**

In `entitlements.plist`, replace the misleading `<!-- Electron / V8 -->` comment with one noting these are for WebKit's JavaScriptCore JIT and the bundled Node's V8 JIT. Do NOT remove any entitlement — all are needed under hardened runtime.

- [ ] **Step 2: Set the signing identity + minimum system version**

In `tauri.conf.json` `bundle.macOS`, add `"minimumSystemVersion": "13.3"` (WKWebView `isInspectable`/modern APIs) and set the signing identity. Prefer the env var `APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)"` over hardcoding the cert in config (keeps the team-specific string out of git). Confirm Tauri enables hardened runtime for Developer ID signing (it does when signing with a Developer ID cert).

- [ ] **Step 3: Build a signed (not notarized) app**

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAMID>)" npm run tauri:build
```
(Do NOT set the notarization env vars yet — isolate signing first.) Expected: build completes; `.app` under `tauri/src-tauri/target/release/bundle/macos/`.

- [ ] **Step 4: Verify the signature**

```bash
APP="tauri/src-tauri/target/release/bundle/macos/Nexus.app"   # confirm actual name
codesign --verify --deep --strict --verbose=2 "$APP"; echo "exit=$?"
codesign -dvvv "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Runtime|flags"
```
Expected (success): `--verify --deep` exits 0; authority chain shows `Developer ID Application` → `Developer ID Certification Authority` → `Apple Root CA`; `flags=…(runtime)` present (hardened runtime).
**If `--verify --deep` FAILS** pointing at a nested binary (the bundled `node` or a `.node`): that means Tauri didn't sign nested resources — proceed to Task 4. Record the exact failing path.

- [ ] **Step 5: Commit the config (not the identity string)**

```bash
git add tauri/src-tauri/tauri.conf.json tauri/src-tauri/entitlements.plist
git commit -m "build(tauri): macOS Developer ID signing config + hardened runtime"
```

---

## Task 4: Sign nested binaries if Tauri didn't (conditional)

**Files:**
- Create (only if needed): `scripts/sign-nested-binaries.sh`

**Interfaces:**
- Consumes: the signed `.app` (Task 3) + identity.
- Produces: an `.app` where every nested Mach-O (bundled `node`, all `.node`) is signed with hardened runtime, so `codesign --verify --deep` passes and notarization won't reject unsigned nested code.

> Skip this task if Task 3 Step 4 already passed `--verify --deep`. Otherwise:

- [ ] **Step 1: Write the nested-signing sweep**

`scripts/sign-nested-binaries.sh` — sign inner Mach-O first (inside-out), then re-sign the app. The bundled `node` needs the JIT entitlements (V8); `.node` modules sign as libraries:
```bash
#!/usr/bin/env bash
set -euo pipefail
APP="$1"; ID="$2"; ENT="tauri/src-tauri/entitlements.plist"
# Sign the bundled Node with hardened runtime + JIT entitlements (V8).
codesign --force --options runtime --timestamp --entitlements "$ENT" \
  --sign "$ID" "$APP/Contents/Resources/node/bin/node"
# Sign every nested .node (libraries).
find "$APP/Contents/Resources/services" -name '*.node' -print0 \
  | xargs -0 -I{} codesign --force --options runtime --timestamp --sign "$ID" "{}"
# Re-sign the app bundle last (outside-in finalize).
codesign --force --options runtime --timestamp --entitlements "$ENT" \
  --sign "$ID" "$APP"
```

- [ ] **Step 2: Run it + re-verify**

```bash
bash scripts/sign-nested-binaries.sh "$APP" "Developer ID Application: <name> (<TEAMID>)"
codesign --verify --deep --strict --verbose=2 "$APP"; echo "exit=$?"
```
Expected: exits 0.
> Note for later: if this manual sweep is needed, Phase-5 polish should fold it into a Tauri `afterBundle`/signing hook so `tauri build` does it automatically. For now, document it.

- [ ] **Step 3: Commit (if created)**

```bash
git add scripts/sign-nested-binaries.sh
git commit -m "build(tauri): sign bundled node + nested .node modules for notarization"
```

---

## Task 5: Notarize + staple the .app

**Files:** none (uses the built `.app`).

**Interfaces:**
- Consumes: the fully-signed `.app` (Task 3/4), the notarytool profile (Task 1).
- Produces: a notarized + stapled `.app` that `spctl` accepts.

- [ ] **Step 1: Zip and submit for notarization**

```bash
APP="tauri/src-tauri/target/release/bundle/macos/Nexus.app"
ditto -c -k --keepParent "$APP" /tmp/nexus-notarize.zip
xcrun notarytool submit /tmp/nexus-notarize.zip --keychain-profile "nexus-notary" --wait
```
Expected: `status: Accepted`.
**If `Invalid`:** fetch the log and fix — `xcrun notarytool log <submission-id> --keychain-profile "nexus-notary"`. The usual causes are an unsigned/foreign nested binary (→ Task 2 prune or Task 4 signing missed something) or missing hardened runtime. Record + resolve, resubmit.

- [ ] **Step 2: Staple the ticket to the .app**

```bash
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"; echo "exit=$?"
```
Expected: `The validate action worked!`, exit 0.

- [ ] **Step 3: Verify Gatekeeper acceptance**

```bash
spctl --assess --type execute --verbose=2 "$APP"
```
Expected: `accepted` + `source=Notarized Developer ID`.

- [ ] **Step 4: Functional check — signed+notarized app runs**

Ensure ports are clear, then `open "$APP"` (GUI launch). Confirm it boots, spawns services under the (now-signed) bundled node (`:4173/api/health` → 200), the UI works, and quitting reaps the services. This proves signing/hardened-runtime didn't break the bundled-Node spawn (e.g. library validation).

---

## Task 6 (Phase 4): Build, sign, notarize, and staple the DMG

**Files:**
- Modify: `tauri/src-tauri/tauri.conf.json` (`bundle.targets` → add `"dmg"`)

**Interfaces:**
- Consumes: the working signed/notarized app pipeline.
- Produces: a distributable, notarized, stapled `.dmg`.

- [ ] **Step 1: Add the dmg target + rebuild with notarization**

Set `bundle.targets` to `["app", "dmg"]`. Build with both signing identity AND notarization creds set so Tauri signs+notarizes in one pass:
```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAMID>)" \
  <notarization env vars OR rely on the keychain profile per Tauri docs> \
  npm run tauri:build
```
(Confirm how Tauri v2 consumes the notarytool profile vs explicit `APPLE_API_*`/`APPLE_ID` env. If Tauri's built-in notarization is finicky, fall back to: build app-only signed, run Task 5 manually, then `hdiutil`/`create-dmg` + sign + notarize + staple the dmg.) Expected: a `.dmg` under `.../bundle/dmg/`.

- [ ] **Step 2: Verify the DMG is notarized + stapled**

```bash
DMG=$(ls tauri/src-tauri/target/release/bundle/dmg/*.dmg | head -1)
xcrun stapler validate "$DMG"; echo "exit=$?"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
```
Expected: stapler validates; spctl accepts.

- [ ] **Step 3: Clean-machine simulation**

Mount the DMG, copy `Nexus.app` to `/Applications`, remove the quarantine-free local build advantage by checking Gatekeeper on the copied app:
```bash
xattr -w com.apple.quarantine "0081;00000000;Safari;" "/Applications/Nexus.app" 2>/dev/null || true
spctl --assess --type execute --verbose=2 "/Applications/Nexus.app"
```
Expected: `accepted` (notarized) even with a quarantine attribute — i.e. it would launch on someone else's Mac without a Gatekeeper block. Launch it and confirm it runs.

---

## Task 7: Result doc

**Files:**
- Create: `docs/superpowers/specs/2026-06-23-tauri-signing-result.md`

- [ ] **Step 1: Document the outcome**

Record: the signing identity + notarization method used; whether Tauri signed nested binaries or Task 4's sweep was needed; the foreign-arch prune (what was removed); the final `spctl`/`stapler` verification output; the notarized `.dmg` location; and any follow-ups (e.g. fold nested-signing into a Tauri hook in Phase 5; revisit if pi-tui changes its prebuilds). Note the credential setup is local-only (not in git).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-tauri-signing-result.md
git commit -m "docs(tauri): signing + notarization result (phase 3-4)"
```

---

## Self-Review

**1. Spec coverage (Phase 3 + 4):**
- "Developer ID identity + hardened runtime + finalize entitlements" → Tasks 1, 3. ✓
- "every nested Mach-O must be signed (bundled node, .node modules)" → Task 4 (conditional, with empirical gate in Task 3 Step 4). ✓ (spawn-helper: not present in the current stage; the `.node` sweep covers any that appear.)
- "sign → notarize → staple → spctl passes" → Tasks 3→5. ✓
- "distributable notarized .dmg, Gatekeeper-clean" → Task 6. ✓
- Foreign-arch prune (discovered in recon; not in the spec but required for notarization to succeed) → Task 2. ✓ (gap surfaced + closed)
- entitlements: keep `allow-jit` etc. (WebKit JSC + Node V8) — corrects the spec §4's "drop allow-jit if WebKit doesn't need them," because the bundled Node's V8 DOES need it. Documented in Task 3 Step 1. ✓

**2. Placeholder scan:** No TBD/TODO. `<name>`/`<TEAMID>`/`<KEY_ID>` are credential placeholders the maintainer fills from Task 1 (unavoidable — they're account-specific secrets), not vague logic. Task 4 is explicitly conditional on Task 3's empirical result. The one genuine unknown — whether Tauri v2 signs nested resources and how it consumes notarytool creds — is handled by verify-then-branch (Task 3 Step 4 → Task 4) and the Task 6 Step 1 fallback, not hand-waved.

**3. Consistency:** `$APP` path, the `nexus-notary` profile name, the identity string form, and `entitlements.plist` path are consistent across Tasks 3–6. The prune patterns (Task 2) match the foreign dirs found in recon (`win32-*`, `darwin-x64`).

**Execution note:** Task 1 is maintainer-driven (Apple account). Tasks 2–7 are agent-drivable once the identity exists and notarization creds are provided as env/keychain — but each notarization round-trip needs network + the maintainer's creds. Flag at handoff: this phase is collaborative, like Phase 1.
