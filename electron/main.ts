import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

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

/** Poll a health URL until it answers or we give up (~30s default). */
async function waitForHealth(url: string, tries = 75, intervalMs = 400): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await probe(url)) return true;
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
      env: process.env,
    }),
  );
}

/**
 * Spawn a compiled Node entry point under the *system* `node` (prod). We can't
 * use Electron's `fork()` here: it forces ELECTRON_RUN_AS_NODE, so the child
 * runs under Electron's bundled Node ABI and fails to load the native
 * better-sqlite3 (compiled against system Node). `spawn('node', …)` uses the
 * matching system runtime, and — detached — shares the dev group-kill cleanup.
 */
function spawnNode(relEntry: string): ChildProcess {
  return track(
    spawn('node', [path.join(REPO_ROOT, relEntry)], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: 'inherit',
      env: process.env,
    }),
  );
}

function spawnDaemon() {
  if (isDev) spawnNpm('src/memory-daemon', ['start']);
  else spawnNode(path.join('src', 'memory-daemon', 'dist', 'src', 'index.js'));
}
function spawnBackend() {
  if (isDev) spawnNpm('src/backend', ['run', 'dev']);
  else spawnNode(path.join('src', 'backend', 'dist', 'index.js'));
}
function spawnFrontend() {
  // Dev only — in prod the frontend is bundled and loaded from disk.
  spawnNpm('src/frontend', ['run', 'dev']);
}

/**
 * Ensure a service is healthy: probe first (reuse anything already running, e.g.
 * the daemon under LaunchD), otherwise spawn it and wait for its health port.
 */
async function ensureService(key: string, healthUrl: string, spawnFn: () => void): Promise<boolean> {
  set(key, 'starting', 'checking…');
  if (await probe(healthUrl)) {
    set(key, 'reused');
    return true;
  }
  set(key, 'spawning');
  try {
    spawnFn();
  } catch (err: any) {
    set(key, 'failed', err?.message ?? 'spawn error');
    return false;
  }
  const ok = await waitForHealth(healthUrl);
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
    mainWindow.loadFile(path.join(REPO_ROOT, 'src', 'frontend', 'dist', 'index.html'));
  }

  mainWindow.webContents.once('did-finish-load', () => {
    if (isDev) mainWindow?.webContents.openDevTools();
    mainWindow?.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
  });
}

async function boot() {
  await createSplash();
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
