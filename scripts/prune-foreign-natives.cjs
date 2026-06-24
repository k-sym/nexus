#!/usr/bin/env node
/**
 * Remove non-(macOS arm64) native artifacts from .stage/services so codesign and
 * notarization don't choke on foreign Mach-O / PE binaries. This is a macOS-arm64-only
 * build (see docs/superpowers/specs/2026-06-23-tauri-full-conversion-design.md).
 *
 * Some bundled packages (e.g. @earendil-works/pi-tui) ship prebuilt native modules for
 * every platform (win32-*, darwin-x64, linux-*). Those are never loaded on macOS arm64,
 * but their presence breaks `codesign --deep` / notarization (foreign Mach-O and PE
 * binaries can't be signed as part of an arm64 app). Prune them. Idempotent.
 *
 * Runs in `prepackage` after `stage:services`. Precedent: the node-pty prune in
 * scripts/stage-services.cjs.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVICES = path.join(ROOT, '.stage', 'services');
// Directory path fragments that denote a non-(darwin-arm64) prebuild tree.
const FOREIGN_DIR = /(win32|linux|android)[-/]|darwin-x64|[-/]x64[-/]|ia32/i;

let removed = 0;

function arch(p) {
  try {
    return execFileSync('file', ['-b', p], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (FOREIGN_DIR.test(p + '/')) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
        console.log('[prune] dir ', path.relative(ROOT, p));
        continue;
      }
      walk(p);
    } else if (e.isFile() && p.endsWith('.node')) {
      const desc = arch(p);
      // Keep anything with an arm64 slice (thin arm64 OR a universal binary that
      // includes arm64 — universals sign + run fine on Apple Silicon). Drop only
      // pure-foreign binaries: x86_64-only Mach-O, PE32 (win32), ELF (linux).
      if (desc && !/arm64/.test(desc)) {
        fs.rmSync(p, { force: true });
        removed++;
        console.log('[prune] file', path.relative(ROOT, p), '—', desc.slice(0, 40));
      }
    }
  }
}

if (fs.existsSync(SERVICES)) {
  walk(SERVICES);
} else {
  console.log('[prune] no .stage/services — nothing to prune');
}
console.log(`[prune] removed ${removed} foreign native artifact(s)`);
