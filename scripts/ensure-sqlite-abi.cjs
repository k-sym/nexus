#!/usr/bin/env node
/**
 * Guard against the better-sqlite3 NODE_MODULE_VERSION (ABI) mismatch.
 *
 * The backend and the memory-daemon always run under *system Node*
 * (see electron/main.ts: prod spawns `node`, never Electron's fork()),
 * so better-sqlite3 must be compiled for the running Node's ABI.
 *
 * If a stray `electron-rebuild` / Electron packaging step recompiled it for
 * Electron's bundled Node (a different ABI), the process dies at startup with
 * a cryptic ERR_DLOPEN_FAILED. This runs before the process boots: it verifies
 * the native module loads under the current Node and, if not, rebuilds the
 * install that owns it for the current Node — then re-verifies.
 *
 * Usage: node scripts/ensure-sqlite-abi.cjs <label>
 *   <label> is a human tag for log lines (e.g. "backend", "daemon").
 *   The install to check/rebuild is resolved from the current working dir,
 *   so run it from the package whose better-sqlite3 you want to guard.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const label = process.argv[2] || 'sqlite';
const fromCwd = process.cwd();

/** Locate the better-sqlite3 install as *this* package resolves it. */
function locate() {
  const pj = require.resolve('better-sqlite3/package.json', { paths: [fromCwd] });
  const pkgDir = path.dirname(pj); //  .../node_modules/better-sqlite3
  const installRoot = path.resolve(pkgDir, '..', '..'); //  dir that owns node_modules
  return { pkgDir, installRoot };
}

/** True if the native module loads under the current Node (checked in a clean child). */
function canLoad() {
  try {
    execFileSync(
      process.execPath,
      ['-e', 'const D=require("better-sqlite3");new D(":memory:").close();'],
      { cwd: fromCwd, stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

let installRoot;
try {
  ({ installRoot } = locate());
} catch (err) {
  // Not installed / unresolvable — not this guard's job to fix. Let the real
  // process surface a clear "cannot find module" error.
  console.warn(`[sqlite-abi] ${label}: could not resolve better-sqlite3 (${err.message}); skipping ABI check.`);
  process.exit(0);
}

if (canLoad()) process.exit(0);

console.warn(
  `[sqlite-abi] ${label}: better-sqlite3 is built for the wrong Node ABI; ` +
    `rebuilding for ${process.version} in ${installRoot} …`,
);
try {
  execFileSync('npm', ['rebuild', 'better-sqlite3', '--prefix', installRoot], { stdio: 'inherit' });
} catch (err) {
  console.error(`[sqlite-abi] ${label}: rebuild failed: ${err.message}`);
  process.exit(1);
}

if (!canLoad()) {
  console.error(
    `[sqlite-abi] ${label}: still cannot load better-sqlite3 after rebuild. ` +
      `Try \`npm rebuild better-sqlite3 --prefix ${installRoot}\` manually.`,
  );
  process.exit(1);
}
console.warn(`[sqlite-abi] ${label}: rebuilt OK for ${process.version}.`);
