#!/usr/bin/env node
/*
 * node-pty (v1.1.0) ships a prebuilt `spawn-helper` binary under
 * `node-pty/prebuilds/<platform>/spawn-helper` WITHOUT the execute bit. On
 * POSIX systems this makes the backend's PTY spawn fail with
 * `Error: posix_spawnp failed.`. `npm rebuild node-pty` does not fix it (it
 * reuses the same prebuild), and a manual `chmod +x` is lost on every fresh
 * `npm install`.
 *
 * This script runs as a `postinstall` hook to durably restore the execute bit
 * on fresh checkouts / CI / packaged builds. It is a no-op on Windows (the
 * helper is a `.exe` that needs no chmod) and when the file is absent.
 *
 * Because this repo uses npm workspaces, node-pty is normally hoisted to the
 * root `node_modules`, but we scan a few candidate locations to be safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// chmod is meaningless on Windows — bail out cleanly.
if (process.platform === 'win32') {
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');

// Candidate `node-pty` package roots (hoisted root first, then the backend
// workspace in case npm did not hoist it).
const candidateModuleDirs = [
  path.join(repoRoot, 'node_modules', 'node-pty'),
  path.join(repoRoot, 'src', 'backend', 'node_modules', 'node-pty'),
];

let fixed = 0;
let scanned = 0;

for (const moduleDir of candidateModuleDirs) {
  const prebuildsDir = path.join(moduleDir, 'prebuilds');
  let platforms;
  try {
    platforms = fs.readdirSync(prebuildsDir);
  } catch {
    continue; // node-pty not here, or no prebuilds dir — skip silently.
  }

  for (const platform of platforms) {
    const helper = path.join(prebuildsDir, platform, 'spawn-helper');
    let stat;
    try {
      stat = fs.statSync(helper);
    } catch {
      continue; // No spawn-helper for this platform — fine.
    }
    if (!stat.isFile()) continue;

    scanned += 1;
    // Add execute bits for user/group/other (preserve the rest of the mode).
    const desired = stat.mode | 0o111;
    if (desired === stat.mode) continue; // Already executable.

    try {
      fs.chmodSync(helper, desired);
      fixed += 1;
      console.log(`[fix-node-pty] chmod +x ${path.relative(repoRoot, helper)}`);
    } catch (err) {
      // Don't fail the install over a permissions tweak — just warn.
      console.warn(`[fix-node-pty] could not chmod ${helper}: ${err.message}`);
    }
  }
}

if (scanned === 0) {
  // Nothing to do (node-pty not installed yet, or a platform without prebuilds).
  process.exit(0);
}

if (fixed === 0) {
  console.log('[fix-node-pty] spawn-helper already executable; nothing to do.');
}
