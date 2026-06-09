import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, execFileSync, ChildProcess } from 'child_process';

// __dirname is electron/dist at runtime, so the repo root is two levels up.
const REPO_ROOT = path.join(__dirname, '..', '..');

// Dev mode = unpackaged AND not explicitly forced into prod. Setting
// NEXUS_ELECTRON_PROD=1 lets you exercise the production flow (compiled
// backend/daemon, built frontend) without packaging the app.
const isDev = !app.isPackaged && process.env.NEXUS_ELECTRON_PROD !== '1';

// Health endpoints + the prod API base the frontend talks to.
const DAEMON_HEALTH = 'http://127.0.0.1:4100/health';
const BACKEND_HEALTH = 'http://127.0.0.1:4173/api/health';
const FRONTEND_URL = 'http://localhost:5173/';
const API_BASE = 'http://127.0.0.1:4173/api';

type State = 'pending' | 'starting' | 'spawning' | 'up' | 'reused' | 'warn' | 'failed' | 'skipped';
interface ServiceStatus { state: State; detail?: string }

const status: Record<string, ServiceStatus> = {
  memory: { state: 'pending' },
  backend: { state: 'pending' },
  frontend: { state: 'pending' },
  models: { state: 'pending' },
};

let splashWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
const children: ChildProcess[] = [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── Node runtime resolution ─────────────────────────
//
// The backend and memory-daemon run under *system* Node (never Electron's
// fork()/ELECTRON_RUN_AS_NODE, which would load Electron's ABI and break the
// native better-sqlite3 they depend on). Two hazards we guard against here:
//
//   1. A GUI launch (Finder/Dock on macOS, a .desktop entry on Linux) does NOT
//      inherit the user's shell PATH, so a bare `spawn('node')` ENOENTs even
//      when `node` works fine in a terminal. We resolve an absolute path by
//      probing PATH first, then the usual install locations + version managers.
//   2. The resolved Node must satisfy our engines floor (>=20).
//
// Set NEXUS_NODE to force a specific binary.
let cachedNode: string | null | undefined;

/** Path to the Node runtime we ship in the packaged app (known ABI), or null. */
function bundledNode(): string | null {
  if (!app.isPackaged) return null;
  return process.platform === 'win32'
    ? path.join(process.resourcesPath, 'node', 'node.exe')
    : path.join(process.resourcesPath, 'node', 'bin', 'node');
}

function nodeCandidates(): string[] {
  const home = app.getPath('home');
  const fixed = [
    process.env.NEXUS_NODE,
    bundledNode() ?? undefined, // packaged: the Node we shipped (matching ABI)
    'node', // PATH — works in dev / when the env is inherited
    '/opt/homebrew/bin/node', // macOS arm64 Homebrew
    '/usr/local/bin/node', // macOS x64 Homebrew / generic
    '/usr/bin/node', // Linux distro packages
    path.join(home, '.volta', 'bin', 'node'),
  ].filter(Boolean) as string[];

  // Best-effort scan of nvm / fnm version dirs (newest first, lexically). The
  // >=20 check below is the real gate; this only affects which match we try
  // first, and PATH/Homebrew usually win before we get here anyway.
  const scanned: string[] = [];
  for (const [base, leaf] of [
    [path.join(home, '.nvm', 'versions', 'node'), ['bin', 'node']],
    [path.join(home, '.fnm', 'node-versions'), ['installation', 'bin', 'node']],
  ] as Array<[string, string[]]>) {
    try {
      for (const v of fs.readdirSync(base).sort().reverse()) {
        scanned.push(path.join(base, v, ...leaf));
      }
    } catch {
      /* version manager not present */
    }
  }
  return [...fixed, ...scanned];
}

/** Resolve an absolute path to a usable system Node (>=20), or null. Cached. */
function resolveNode(): string | null {
  if (cachedNode !== undefined) return cachedNode;
  for (const cmd of nodeCandidates()) {
    try {
      const v = execFileSync(cmd, ['--version'], { encoding: 'utf8' }).trim();
      const major = Number.parseInt(v.replace(/^v/, '').split('.')[0], 10);
      if (major >= 20) {
        cachedNode = cmd;
        return cmd;
      }
    } catch {
      /* not here / not runnable — try the next candidate */
    }
  }
  cachedNode = null;
  return null;
}

/**
 * Environment for spawned services: the parent env plus a PATH enriched with
 * the resolved Node's dir and the common bin locations. Without this, a
 * GUI-launched app hands its children a bare PATH and their own subprocesses
 * (terminal threads, git, node) go missing.
 */
function spawnEnv(): NodeJS.ProcessEnv {
  const node = resolveNode();
  const extra = [
    node ? path.dirname(node) : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean) as string[];
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...current, ...extra])].join(path.delimiter);
  return { ...process.env, PATH: merged };
}

/**
 * Mirror the dev `predev`/`prestart` ABI guard for the prod-sim flow
 * (NEXUS_ELECTRON_PROD=1): compiled services are spawned directly via node,
 * bypassing the npm scripts that normally run ensure-sqlite-abi. Best-effort —
 * skipped once packaged (read-only resources, no npm; shipping a correctly
 * built binary is the packaging step's job) and never fatal here (a real load
 * failure still surfaces when the service boots).
 */
function ensureNativeAbi(label: string, pkgCwd: string): void {
  if (app.isPackaged) return;
  const node = resolveNode();
  if (!node) return;
  try {
    execFileSync(node, [path.join(REPO_ROOT, 'scripts', 'ensure-sqlite-abi.cjs'), label], {
      cwd: pkgCwd,
      stdio: 'inherit',
    });
  } catch (err) {
    console.error(`[nexus] ABI guard (${label}) failed:`, err);
  }
}

function pushStatus(message?: string) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('boot:status', { services: status, message });
  }
}

function set(key: string, state: State, detail?: string) {
  status[key] = { state, detail };
  pushStatus();
}

/** Track a spawned child so we can reap it on quit. */
function track(child: ChildProcess): ChildProcess {
  children.push(child);
  child.on('error', (err) => console.error('[nexus] child error:', err));
  return child;
}

/** GET a health URL with a short timeout; true iff it answers 2xx. */
async function probe(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll a health URL until it answers or we give up (~30s default). `aborted`,
 * when supplied, short-circuits the wait early (e.g. the child already died).
 */
async function waitForHealth(
  url: string,
  tries = 75,
  intervalMs = 400,
  aborted?: () => boolean,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await probe(url)) return true;
    if (aborted?.()) return false;
    await delay(intervalMs);
  }
  return false;
}

/** Spawn an npm script in a workspace (dev), detached so we can kill the group. */
function spawnNpm(relCwd: string, args: string[]): ChildProcess {
  return track(
    spawn('npm', args, {
      cwd: path.join(REPO_ROOT, relCwd),
      detached: true,
      stdio: 'inherit',
      env: spawnEnv(),
    }),
  );
}

/**
 * Spawn a compiled Node entry point under the *system* `node` (prod). We can't
 * use Electron's `fork()` here: it forces ELECTRON_RUN_AS_NODE, so the child
 * runs under Electron's bundled Node ABI and fails to load the native
 * better-sqlite3 (compiled against system Node). The resolved system `node`
 * (see resolveNode) provides the matching runtime, and — detached — shares the
 * dev group-kill cleanup.
 */
function spawnNode(entryAbs: string, cwd: string): ChildProcess {
  const node = resolveNode();
  if (!node) {
    throw new Error('No compatible Node.js (v20+) found on this system.');
  }
  return track(
    spawn(node, [entryAbs], {
      cwd,
      detached: true,
      stdio: 'inherit',
      env: spawnEnv(),
    }),
  );
}

// ───────────────────────────── Service locations ────────────────────────────
//
// The backend and memory-daemon run as standalone Node processes (external
// node, never Electron's fork — see spawnNode). They CANNOT live inside
// app.asar (external node can't read an asar), so when packaged they ship as
// real directories under Contents/Resources/services (electron-builder
// extraResources). Unpackaged (dev / NEXUS_ELECTRON_PROD=1 from the repo) they
// resolve to the workspaces. Both read their data from $HOME (~/.nexus,
// ~/Obsidian/Nexus), so they're cwd-insensitive — cwd here only anchors the ABI
// guard + node_modules resolution.
const SERVICES = app.isPackaged ? path.join(process.resourcesPath, 'services') : null;

function backendDir(): string {
  return SERVICES ? path.join(SERVICES, 'backend') : path.join(REPO_ROOT, 'src', 'backend');
}
function daemonDir(): string {
  return SERVICES ? path.join(SERVICES, 'daemon') : path.join(REPO_ROOT, 'src', 'memory-daemon');
}
function frontendIndexHtml(): string {
  return SERVICES
    ? path.join(SERVICES, 'frontend', 'dist', 'index.html')
    : path.join(REPO_ROOT, 'src', 'frontend', 'dist', 'index.html');
}

function spawnDaemon(): ChildProcess {
  if (isDev) return spawnNpm('src/memory-daemon', ['start']);
  ensureNativeAbi('daemon', daemonDir());
  return spawnNode(path.join(daemonDir(), 'dist', 'src', 'index.js'), daemonDir());
}
function spawnBackend(): ChildProcess {
  if (isDev) return spawnNpm('src/backend', ['run', 'dev']);
  ensureNativeAbi('backend', backendDir());
  return spawnNode(path.join(backendDir(), 'dist', 'index.js'), backendDir());
}
function spawnFrontend(): ChildProcess {
  // Dev only — in prod the frontend is bundled and loaded from disk.
  return spawnNpm('src/frontend', ['run', 'dev']);
}

/**
 * Ensure a service is healthy: probe first (reuse anything already running, e.g.
 * the daemon under LaunchD), otherwise spawn it and wait for its health port.
 */
async function ensureService(
  key: string,
  healthUrl: string,
  spawnFn: () => ChildProcess,
): Promise<boolean> {
  set(key, 'starting', 'checking…');
  if (await probe(healthUrl)) {
    set(key, 'reused');
    return true;
  }
  set(key, 'spawning');
  let child: ChildProcess;
  try {
    child = spawnFn();
  } catch (err: any) {
    set(key, 'failed', err?.message ?? 'spawn error');
    return false;
  }

  // Fail fast: if the child dies before health comes up (ENOENT, crash, bad
  // ABI), surface the real reason immediately instead of waiting out the full
  // ~30s health timeout.
  let earlyExit: string | null = null;
  const onError = (err: NodeJS.ErrnoException) => {
    earlyExit = err.code === 'ENOENT' ? 'runtime not found' : err.message;
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (earlyExit === null) earlyExit = `exited early (${signal ?? code ?? 'unknown'})`;
  };
  child.once('error', onError);
  child.once('exit', onExit);

  const ok = await waitForHealth(healthUrl, 75, 400, () => earlyExit !== null);
  child.removeListener('error', onError);
  child.removeListener('exit', onExit);

  if (!ok && earlyExit) {
    set(key, 'failed', earlyExit);
    return false;
  }
  set(key, ok ? 'up' : 'failed', ok ? undefined : 'timeout');
  return ok;
}

/** Read the LLM stack status off the daemon's /health (it probes 4001/4002/4003). */
async function checkModels(): Promise<boolean> {
  set('models', 'starting', 'probing…');
  try {
    const res = await fetch(DAEMON_HEALTH);
    const body: any = await res.json();
    const m = body?.models ?? {};
    const want = ['gen', 'embed', 'rerank'] as const;
    const down = want.filter((k) => !m[k]);
    if (down.length === 0) {
      set('models', 'up');
      return true;
    }
    set('models', 'warn', `down: ${down.join(', ')}`);
    return false;
  } catch {
    set('models', 'warn', 'unknown');
    return false;
  }
}

function createSplash(): Promise<void> {
  return new Promise((resolve) => {
    splashWindow = new BrowserWindow({
      width: 480,
      height: 380,
      frame: false,
      resizable: false,
      backgroundColor: '#0a0a0f',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    splashWindow.loadFile(path.join(__dirname, '..', 'splash.html'));
    splashWindow.once('ready-to-show', () => splashWindow?.show());
    splashWindow.webContents.once('did-finish-load', () => resolve());
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      // Prod loads from file:// and needs an absolute API base; dev uses the vite proxy.
      additionalArguments: isDev ? [] : [`--nexus-api-base=${API_BASE}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(FRONTEND_URL);
  } else {
    mainWindow.loadFile(frontendIndexHtml());
  }

  mainWindow.webContents.once('did-finish-load', () => {
    if (isDev) mainWindow?.webContents.openDevTools();
    mainWindow?.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
  });
}

/**
 * Verify a usable Node runtime exists before we try to boot services. In dev
 * we're launched from a shell (node is on PATH); only the prod/packaged flow,
 * which spawns compiled services under system node, needs this gate.
 */
async function preflightRuntime(): Promise<boolean> {
  if (isDev) return true;
  if (resolveNode()) return true;
  await dialog.showMessageBox({
    type: 'error',
    title: 'Node.js runtime not found',
    message: 'Nexus could not find a compatible Node.js (v20 or newer).',
    detail:
      'Nexus runs its backend and memory services under Node. Install Node 20+ ' +
      '(e.g. `brew install node`) and relaunch.\n\n' +
      'If Node is installed but not detected, set NEXUS_NODE to its full path.',
    buttons: ['Quit'],
    defaultId: 0,
    noLink: true,
  });
  return false;
}

async function boot() {
  await createSplash();

  // Gate on a usable Node runtime before spawning anything (prod/packaged only).
  if (!(await preflightRuntime())) {
    app.quit();
    return;
  }

  pushStatus('Starting services…');

  // Memory daemon first (the backend's memory client wants it).
  const memOk = await ensureService('memory', DAEMON_HEALTH, spawnDaemon);

  // LLM stack status comes off the daemon's health blob.
  let modelsOk = false;
  if (memOk) modelsOk = await checkModels();
  else set('models', 'warn', 'daemon down');

  // Backend, then (dev only) the vite frontend server.
  const backendOk = await ensureService('backend', BACKEND_HEALTH, spawnBackend);
  let frontendOk = true;
  if (isDev) frontendOk = await ensureService('frontend', FRONTEND_URL, spawnFrontend);
  else set('frontend', 'skipped', 'bundled');

  // The UI requires the backend (and, in dev, the vite server). The daemon is
  // optional — memory degrades gracefully — so it isn't gating.
  const ready = backendOk && frontendOk;

  if (!modelsOk) {
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'Local model stack not fully up',
      message: 'The local LLM services (llama on 4001 / 4002 / 4003) are not all reachable.',
      detail:
        'Start these services for full memory & retrieval. Nexus will continue in degraded mode (FTS-only recall).',
      buttons: ['Continue'],
      defaultId: 0,
      noLink: true,
    };
    // Parent it to whatever window is alive (splash at this point) so it's modal.
    if (splashWindow && !splashWindow.isDestroyed()) await dialog.showMessageBox(splashWindow, opts);
    else await dialog.showMessageBox(opts);
  }

  if (ready) {
    pushStatus('Ready — opening Nexus…');
    createMainWindow();
  } else {
    pushStatus('Startup failed — a required service did not come up.');
  }
}

function killChildren() {
  for (const child of children) {
    if (!child.pid || child.killed) continue;
    try {
      // Detached children lead their own group; kill the whole group.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // This app owns its services; closing the window tears them down and quits
  // (rather than lingering as a tray-less mac app with orphaned servers).
  killChildren();
  app.quit();
});

app.on('before-quit', killChildren);
