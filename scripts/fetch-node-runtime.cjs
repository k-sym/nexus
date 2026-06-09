#!/usr/bin/env node
/**
 * Download the official Node runtime — matching THIS Node's version, so the
 * native modules staged by stage-services.cjs share its ABI — for the host
 * platform into .stage/node/. electron-builder ships it via extraResources and
 * the packaged app spawns the backend/daemon under it (see electron/main.ts
 * bundledNode()).
 *
 * Host-platform only: cross-platform packaging is a per-OS CI concern (native
 * modules can't be cross-built here anyway).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.stage', 'node');
const ver = process.versions.node;
const arch = process.arch; // arm64 | x64
const log = (...a) => console.log('[fetch-node]', ...a);

const plat =
  process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'linux'
      ? 'linux'
      : process.platform === 'win32'
        ? 'win'
        : null;
if (!plat) throw new Error(`unsupported platform: ${process.platform}`);

const nodeBin = plat === 'win' ? path.join(OUT, 'node.exe') : path.join(OUT, 'bin', 'node');
const stamp = path.join(OUT, '.node-version');

if (fs.existsSync(nodeBin) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === ver) {
  log(`v${ver} already staged`);
  process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const base = `https://nodejs.org/dist/v${ver}`;
const tmp = path.join(ROOT, '.stage', '.node-dl');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

if (plat === 'win') {
  const name = `node-v${ver}-win-${arch}`;
  const zip = path.join(tmp, `${name}.zip`);
  log(`downloading ${name}.zip`);
  execFileSync('curl', ['-fL', '-o', zip, `${base}/${name}.zip`], { stdio: 'inherit' });
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${tmp}'`], {
    stdio: 'inherit',
  });
  fs.copyFileSync(path.join(tmp, name, 'node.exe'), nodeBin);
} else {
  const name = `node-v${ver}-${plat}-${arch}`;
  const tgz = path.join(tmp, `${name}.tar.gz`);
  log(`downloading ${name}.tar.gz`);
  execFileSync('curl', ['-fL', '-o', tgz, `${base}/${name}.tar.gz`], { stdio: 'inherit' });
  execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' });
  fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(tmp, name, 'bin', 'node'), nodeBin);
  fs.chmodSync(nodeBin, 0o755);
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(stamp, ver);
log(`node v${ver} →`, nodeBin);
