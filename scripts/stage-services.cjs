#!/usr/bin/env node
/**
 * Stage the externally-spawned services into .stage/services/ as self-contained,
 * production-only trees the packaged app runs under the bundled Node.
 *
 *   .stage/services/backend  ← dist + prod node_modules (incl. @nexus/shared) + package.json
 *   .stage/services/daemon   ← dist + prod node_modules + package.json
 *   .stage/services/frontend ← dist (static assets only)
 *
 * Run AFTER `npm run build` (which produces every dist/) and BEFORE
 * electron-builder, which copies .stage/services via extraResources. Native
 * modules (better-sqlite3, node-pty, sqlite-vec) are installed/built here under
 * the SAME Node that runs this script — the version we also bundle — so their
 * ABI matches at runtime. See scripts/fetch-node-runtime.cjs.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.stage');
const OUT = path.join(STAGE, 'services');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const log = (...a) => console.log('[stage-services]', ...a);
const npm = (args, cwd) => execFileSync(NPM, args, { cwd, stdio: 'inherit' });

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
function copyDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
function need(p, hint) {
  if (!fs.existsSync(p)) throw new Error(`missing ${p} — ${hint}`);
}
// node-pty bundles prebuilds + a Windows conpty.dll for every platform. Shipping
// foreign binaries in a mac/arm64 app bloats it and makes codesign fail (it
// can't sign a Windows PE). Keep only the host platform+arch.
function pruneNodePty(moduleRoot) {
  const npty = path.join(moduleRoot, 'node_modules', 'node-pty');
  const keep = `${process.platform}-${process.arch}`;
  const prebuilds = path.join(npty, 'prebuilds');
  try {
    for (const d of fs.readdirSync(prebuilds)) {
      if (d !== keep) fs.rmSync(path.join(prebuilds, d), { recursive: true, force: true });
    }
  } catch {
    /* no prebuilds dir */
  }
  // third_party/conpty is Windows-only.
  if (process.platform !== 'win32') {
    fs.rmSync(path.join(npty, 'third_party'), { recursive: true, force: true });
  }
}

// node-pty ships spawn-helper without +x; a fresh install drops it again.
function fixSpawnHelper(moduleRoot) {
  const prebuilds = path.join(moduleRoot, 'node_modules', 'node-pty', 'prebuilds');
  let platforms;
  try {
    platforms = fs.readdirSync(prebuilds);
  } catch {
    return;
  }
  for (const p of platforms) {
    const helper = path.join(prebuilds, p, 'spawn-helper');
    try {
      const st = fs.statSync(helper);
      if (st.isFile()) fs.chmodSync(helper, st.mode | 0o111);
    } catch {
      /* none for this platform */
    }
  }
}

function compileTsNodeModules(moduleRoot) {
  const nm = path.join(moduleRoot, 'node_modules');
  if (!fs.existsSync(nm)) return;
  for (const scope of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!scope.isDirectory() || !scope.name.startsWith('@')) continue;
    const scopeDir = path.join(nm, scope.name);
    for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const pkgDir = path.join(scopeDir, pkg.name);
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;
      let pkgJson;
      try { pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')); } catch { continue; }
      const main = pkgJson.main || (typeof pkgJson.exports?.['.'] === 'string' ? pkgJson.exports['.'] : '');
      if (typeof main !== 'string' || !main.endsWith('.ts')) continue;
      log(`  compiling .ts entries in ${scope.name}/${pkg.name}…`);
      const tsFiles = [];
      (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
          else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) tsFiles.push(full);
        }
      })(pkgDir);
      if (tsFiles.length === 0) continue;
      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          outDir: pkgDir,
          rootDir: pkgDir,
          strict: false,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: false,
          noEmit: false,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          isolatedModules: true,
        },
        files: tsFiles,
      };
      const tsconfigPath = path.join(pkgDir, 'tsconfig.staging.json');
      fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      try {
        execFileSync('npx', ['tsc', '-p', tsconfigPath], { cwd: ROOT, stdio: 'inherit' });
      } finally {
        fs.rmSync(tsconfigPath, { force: true });
      }
      for (const ts of tsFiles) fs.rmSync(ts, { force: true });
      pkgJson.main = pkgJson.main.replace(/\.ts$/, '.js');
      if (pkgJson.exports && typeof pkgJson.exports['.'] === 'string') {
        pkgJson.exports['.'] = pkgJson.exports['.'].replace(/\.ts$/, '.js');
      }
      if (pkgJson.pi && Array.isArray(pkgJson.pi.extensions)) {
        pkgJson.pi.extensions = pkgJson.pi.extensions.map(function (e) { return e.replace(/\.ts$/, '.js'); });
      }
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    }
  }
}

reset(OUT);

// ── @nexus/shared → tarball (private workspace dep, not on any registry) ──
need(path.join(ROOT, 'src', 'shared', 'dist'), 'run `npm run build` first');
const packLines = execFileSync(NPM, ['pack', path.join(ROOT, 'src', 'shared'), '--pack-destination', STAGE], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');
const sharedTgz = path.join(STAGE, packLines[packLines.length - 1].trim());
log('packed shared →', path.basename(sharedTgz));

// ── backend ──
{
  const dir = path.join(OUT, 'backend');
  need(path.join(ROOT, 'src', 'backend', 'dist'), 'run `npm run build` first');
  copyDir(path.join(ROOT, 'src', 'backend', 'dist'), path.join(dir, 'dist'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'backend', 'package.json'), 'utf8'));
  // Point the workspace dep at the packed tarball so a registry install resolves it.
  pkg.dependencies['@nexus/shared'] = `file:${sharedTgz}`;
  delete pkg.scripts; // no predev/ABI-guard hooks in the shipped tree
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  log('installing backend prod deps…');
  npm(['install', '--omit=dev', '--no-workspaces', '--no-audit', '--no-fund'], dir);
  pruneNodePty(dir);
  fixSpawnHelper(dir);
  compileTsNodeModules(dir);
}

// ── daemon ──
{
  const dir = path.join(OUT, 'daemon');
  need(path.join(ROOT, 'src', 'memory-daemon', 'dist'), 'run `npm run build` first');
  copyDir(path.join(ROOT, 'src', 'memory-daemon', 'dist'), path.join(dir, 'dist'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'memory-daemon', 'package.json'), 'utf8'));
  delete pkg.scripts;
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  log('installing daemon prod deps…');
  npm(['install', '--omit=dev', '--no-workspaces', '--no-audit', '--no-fund'], dir);
}

// ── frontend (static) ──
{
  need(path.join(ROOT, 'src', 'frontend', 'dist'), 'run `npm run build` first');
  copyDir(path.join(ROOT, 'src', 'frontend', 'dist'), path.join(OUT, 'frontend', 'dist'));
}

log('done →', OUT);
