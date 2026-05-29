import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fork } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ReturnType<typeof fork> | null = null;

// __dirname is electron/dist at runtime, so the repo root is two levels up.
const REPO_ROOT = path.join(__dirname, '..', '..');

// Dev mode = unpackaged AND not explicitly forced into prod. Setting
// NEXUS_ELECTRON_PROD=1 lets you exercise the production flow (boot the
// compiled backend, load the built frontend) without packaging the app.
const isDev = !app.isPackaged && process.env.NEXUS_ELECTRON_PROD !== '1';

function startBackend() {
  const backendEntry = path.join(REPO_ROOT, 'src', 'backend', 'dist', 'index.js');
  backendProcess = fork(backendEntry, [], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(REPO_ROOT, 'src', 'frontend', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  // In dev the backend is run separately (npm run dev:backend via tsx); in
  // prod (packaged, or NEXUS_ELECTRON_PROD=1) we boot the compiled backend.
  if (!isDev) {
    startBackend();
    setTimeout(createWindow, 1500);
  } else {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
