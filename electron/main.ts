import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fork } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ReturnType<typeof fork> | null = null;

function startBackend() {
  const backendEntry = path.join(__dirname, '..', 'src', 'backend', 'dist', 'index.js');
  backendProcess = fork(backendEntry, [], {
    cwd: path.join(__dirname, '..'),
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'frontend', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  startBackend();
  setTimeout(createWindow, 1500);
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
