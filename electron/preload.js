const { contextBridge, ipcRenderer } = require('electron');

// Splash bridge: the main process pushes boot progress over `boot:status`.
// The splash page subscribes via `window.nexusBoot.onStatus(cb)`.
contextBridge.exposeInMainWorld('nexusBoot', {
  onStatus: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('boot:status', handler);
    return () => ipcRenderer.removeListener('boot:status', handler);
  },
});

// In prod the renderer is loaded from file:// (no vite proxy), so the frontend
// needs an absolute API base. Main passes it as a launch arg on the prod window;
// in dev it's absent and the frontend falls back to the proxied '/api'.
const apiArg = process.argv.find((a) => a.startsWith('--nexus-api-base='));
if (apiArg) {
  contextBridge.exposeInMainWorld('__NEXUS_API__', apiArg.slice('--nexus-api-base='.length));
}
