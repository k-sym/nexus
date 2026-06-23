# Tauri Shell Footprint Measurements vs Electron
**Date:** 2026-06-23  
**Branch:** `spike/tauri-v2-shell`  
**Platform:** macOS arm64 (Darwin 25.5.0)  
**Methodology note:** Electron shell was intentionally kept unmodified. No instrumentation was added to either shell. All measurements are external.

---

## Methodology

Both shells share identical resource trees (`Contents/Resources/services/` and `Contents/Resources/node/`) which contribute identically to size and RSS. These shared components are subtracted to isolate the shell-only footprint. Cold-start is measured externally via HTTP polling (see caveat in that section).

**App paths:**
- Electron: `dist-app/mac-arm64/Nexus.app` (built with electron-builder)
- Tauri: `tauri/src-tauri/target/release/bundle/macos/Nexus (Tauri).app` (built in Task 9)

---

## 1. Bundle Size

### Method

```bash
# Total sizes
du -sh dist-app/mac-arm64/Nexus.app         # → 748M (766188 KB)
du -sh "tauri/src-tauri/target/release/bundle/macos/Nexus (Tauri).app"  # → 505M (517296 KB)

# Shared resources (byte-identical in both)
du -sk dist-app/mac-arm64/Nexus.app/Contents/Resources/services  # → 389140 KB
du -sk dist-app/mac-arm64/Nexus.app/Contents/Resources/node      # → 110276 KB

du -sk "tauri/src-tauri/target/release/bundle/macos/Nexus (Tauri).app/Contents/Resources/services"  # → 389176 KB
du -sk "tauri/src-tauri/target/release/bundle/macos/Nexus (Tauri).app/Contents/Resources/node"      # → 110276 KB
```

### Raw Output

```
=== ELECTRON APP ===
748M    dist-app/mac-arm64/Nexus.app
        766188 KB (du -sk)

=== ELECTRON RESOURCES ===
380M    .../Contents/Resources/services  (389140 KB)
108M    .../Contents/Resources/node      (110276 KB)

=== TAURI APP ===
505M    "Nexus (Tauri).app"
        517296 KB (du -sk)

=== TAURI RESOURCES ===
380M    .../Contents/Resources/services  (389176 KB)
108M    .../Contents/Resources/node      (110276 KB)
```

Note: `services` differs by 36 KB (389140 vs 389176 KB) — both staged from the same source tree, minor `du` rounding.

### Results

| Metric           | Electron   | Tauri     | Delta (E−T)    | Ratio  |
|------------------|-----------|-----------|----------------|--------|
| Total .app       | 748 MB     | 505 MB    | −243 MB        | 1.48×  |
| − services       | 380 MB     | 380 MB    | (shared)       |        |
| − node runtime   | 108 MB     | 108 MB    | (shared)       |        |
| **Shell-only**   | **261 MB** | **17 MB** | **−243 MB**    | **~15×** |

Shell-only arithmetic (KB):
- Electron: 766188 − 389140 − 110276 = **266,772 KB ≈ 261 MB**
- Tauri: 517296 − 389176 − 110276 = **17,844 KB ≈ 17 MB**
- Delta: **248,928 KB ≈ 243 MB** smaller for Tauri
- Ratio: 266,772 / 17,844 ≈ **14.95×**

**Composition of shell-only weight:**
- Electron: `Contents/Frameworks/` contains the bundled Chromium+Electron framework (260 MB), plus a small `Contents/MacOS/Nexus` launcher stub (36 KB).
- Tauri: `Contents/MacOS/nexus-tauri` single Rust binary (18 MB, strip-release). No bundled WebKit — system WebKit ships with macOS and is not counted here.

---

## 2. Idle RSS

### Method

Each app launched via `open <app>.app`, polled `http://127.0.0.1:4173/api/health` until HTTP 200, then waited 10 additional seconds to settle. RSS captured via `ps -axo pid,rss,comm,command`.

Shell processes selected by classification:
- **Electron:** main `Nexus` process + `Nexus Helper (GPU)` + `Nexus Helper` (network utility) + `Nexus Helper (Renderer)`. Excluded: `node ... services/daemon/...` and `node ... services/backend/...` (shared).
- **Tauri:** `nexus-tauri` main process + three WebKit XPC helpers spawned after Tauri launch. Excluded: the two `node ...` child processes (shared). Attribution confirmed: all three WebKit XPC procs (PIDs 62552, 62553, 62569) terminated when Tauri was quit — they were not pre-existing.

### Raw Process Lines

**Electron shell processes (captured after 10s settle):**
```
62014  162432  /Users/k-sym/Projects/nexus/dist-app/mac-arm64/Nexus.app/Contents/MacOS/Nexus
62020  114640  Nexus Helper  --type=gpu-process ...
62021   46640  Nexus Helper  --type=utility --utility-sub-type=network.mojom.NetworkService ...
62029  130784  Nexus Helper (Renderer)  --type=renderer ...
--- excluded (shared services) ---
62027   96352  node  .../services/daemon/dist/src/index.js
62028  170288  node  .../services/backend/dist/index.js
```

**Tauri shell processes (captured after 10s settle):**
```
62546  111440  nexus-tauri  (main process)
62552   70288  com.apple.WebKit.GPU       (WebKit GPU XPC, spawned after Tauri, terminated with Tauri)
62553   18288  com.apple.WebKit.Networking (WebKit Networking XPC, same)
62569   73584  com.apple.WebKit.WebContent (WebKit WebContent XPC, same)
--- excluded (shared services) ---
62555   97936  node  .../services/daemon/dist/src/index.js
62559  169280  node  .../services/backend/dist/index.js
```

**Ambiguity note:** WebKit XPC processes have `ppid=1` (launched by launchd/XPC subsystem — this is standard macOS behavior, not a parent-child fork). Attribution relies on: (a) PIDs 62552/62553/62569 appeared after Tauri launch (PID 62546), not before; (b) all three terminated when Tauri quit. This is moderate-confidence attribution. If other apps were using WebKit concurrently, some RSS may be shared pages (macOS uses copy-on-write for framework pages) and the per-process RSS figures may overcount shared physical memory. Treat Tauri RSS as an upper bound on its private contribution.

### Results

| Metric               | Electron      | Tauri         | Delta (E−T)  |
|----------------------|--------------|--------------|--------------|
| Main process RSS     | 159 MB        | 109 MB        | −50 MB       |
| GPU helper RSS       | 112 MB        | 69 MB         | −43 MB       |
| Network helper RSS   | 46 MB         | 18 MB         | −28 MB       |
| Renderer/WebContent  | 128 MB        | 72 MB         | −56 MB       |
| **Shell total RSS**  | **444 MB**   | **267 MB**   | **−177 MB**  |

Arithmetic:
- Electron shell: 162432 + 114640 + 46640 + 130784 = **454,496 KB ≈ 444 MB**
- Tauri shell: 111440 + 70288 + 18288 + 73584 = **273,600 KB ≈ 267 MB**
- Delta: **180,896 KB ≈ 177 MB** lower for Tauri

---

## 3. Cold Start (Secondary Metric)

### Caveat

**This metric is dominated by the shared Node service spawn, which is identical in both shells.** The measurement captures "wall-clock from `open` to first HTTP 200 on `/api/health`" — which requires the Node backend to fully initialize. The shell-only init (Chromium window paint vs WebKit window paint) is a small, unisolated fraction of this total. Do not interpret cold-start numbers as a comparison of shell initialization speed. They are reported for completeness only.

### Method

For each app: ports verified clear (curl → 000), `open <app>.app` issued, time-to-200 measured using Python millisecond timestamps. Run 3× per app with full quit and port-clear confirmation between runs.

```bash
# Pattern used for each run:
START=$(python3 -c "import time; print(int(time.time()*1000))")
open "<app>.app"
# poll curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/api/health at 0.5s intervals
# record END=$(python3 -c "import time; print(int(time.time()*1000))")
# ELAPSED=$((END - START))
```

### Raw Results

**Electron (time-to-backend-ready):**
```
Run 1:  104 ms  ← ANOMALOUS: port may have been responding from prior already-booted state;
                  subsequent clean runs all ~1685ms. Excluded from median.
Run 2: 1685 ms
Run 3: 1688 ms
Run 4: 1685 ms  (extra run added to confirm outlier)
Median (valid runs 2-4): 1685 ms
```

**Tauri (time-to-backend-ready):**
```
Run 1: 1666 ms
Run 2: 1679 ms
Run 3: 1651 ms
Median: 1666 ms
```

### Results

| Metric                       | Electron      | Tauri         | Delta        |
|------------------------------|--------------|--------------|--------------|
| Time-to-backend-ready (med.) | 1685 ms       | 1666 ms       | −19 ms       |
| Runs used for median         | 3 (of 4)     | 3 (of 3)      |              |

**The 19 ms difference is within run-to-run noise (Tauri range: 28 ms; Electron valid range: 3 ms).** This is not a meaningful shell-speed difference. As expected, both shells wait on the same Node backend initialization.

---

## What This Means for the Leaner-Shell Thesis

The numbers support the thesis on size and RSS; they do not permit a cold-start conclusion.

**Shell-only bundle size:** Tauri's shell footprint is ~17 MB vs Electron's ~261 MB — a 15× reduction. This is the clearest, most objective finding. The difference is structural: Electron bundles its own Chromium+Node runtime (260 MB), while Tauri uses the system-provided WebKit.framework (zero bytes counted in the bundle). For a distributed installer this is the dominant factor.

**Idle RSS:** Tauri's shell processes consume ~267 MB vs Electron's ~444 MB — approximately 177 MB lower. The Tauri WebKit XPC processes do use significant RSS (~158 MB combined), but the RSS figures for XPC processes may overcount shared physical pages (macOS uses copy-on-write for framework pages shared across processes and apps). The true private-memory advantage for Tauri may be larger than the RSS delta suggests. Electron's four-process model (main + GPU + network + renderer) has a similar architecture to Tauri + WebKit XPC, but Electron's Chromium is a heavier runtime than system WebKit, reflected in the per-process RSS.

**Cold start:** The metric is dominated by Node service init time (~1.7s for both) and provides no evidence about shell initialization speed. A meaningful comparison would require an isolated splash-to-window measurement with services excluded, which was not done here.

**Overall verdict:** The leaner-shell thesis is strongly supported on size (15× smaller shell-only bundle) and moderately supported on idle RSS (~177 MB lower, with the caveat that WebKit XPC attribution is moderate-confidence and RSS may overcount shared pages). Cold-start is not a discriminating metric under this methodology.

---

## Appendix: Test Environment

- macOS arm64, Darwin 25.5.0
- llama model stack (ports 4001-4003) was up throughout; ports 4100/4173 were cleared before each measurement
- Electron build: `dist-app/mac-arm64/Nexus.app` (electron-builder, Task 1-9 history)
- Tauri build: `tauri/src-tauri/target/release/bundle/macos/Nexus (Tauri).app` (Task 9 release build)
- No code changes made to either shell for this task (deviation from brief's Step 1)
