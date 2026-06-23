#!/usr/bin/env node
/**
 * Static ESM import checker for a compiled `dist/` tree.
 *
 * The backend (and daemon) are native ESM ("type": "module") built with
 * `moduleResolution: "Bundler"`, which lets tsc TYPECHECK extensionless relative
 * imports (`from './foo'`) but emits them verbatim. Node's real ESM loader is
 * strict: relative specifiers must carry an explicit extension and may not point
 * at a directory. tsx (tests + `npm run dev`) hides this, so an extensionless
 * import passes every gate yet crashes the compiled prod/packaged build at boot
 * with ERR_MODULE_NOT_FOUND.
 *
 * This runs as `postbuild`, after tsc, and verifies every relative import/export
 * in the emitted JS resolves to a real FILE — exactly Node's rule — without
 * executing any module (no server boot, no port bind, no side effects).
 *
 * Usage: node scripts/check-esm-dist.cjs <dist-dir>   (default: dist)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || 'dist');

if (!fs.existsSync(root)) {
  console.error(`[check-esm] dist not found: ${root} — run the build first.`);
  process.exit(1);
}

/** All emitted JS files under the dist tree. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Matches relative specifiers in: `from '...'`, side-effect `import '...'`,
// and dynamic `import('...')`. Only relative ones (./ or ../) are our concern;
// bare specifiers are package imports resolved via node_modules. Type-only
// imports are erased by tsc, so they never appear here (no false positives).
const SPEC = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

let problems = 0;
let checked = 0;

for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = SPEC.exec(src)) !== null) {
    const spec = m[1];
    checked++;
    const target = path.resolve(path.dirname(file), spec);
    const isFile = fs.existsSync(target) && fs.statSync(target).isFile();
    if (!isFile) {
      problems++;
      const why = fs.existsSync(target)
        ? "resolves to a directory — use an explicit '<dir>/index.js'"
        : "no such file — missing '.js' extension?";
      console.error(`[check-esm] ${path.relative(process.cwd(), file)}`);
      console.error(`    import '${spec}' -> ${why}`);
    }
  }
}

if (problems > 0) {
  console.error(
    `\n[check-esm] ${problems} unresolved relative import(s) across the dist. ` +
      `Native Node ESM would fail at boot (ERR_MODULE_NOT_FOUND) even though tsc and tsx pass.`,
  );
  process.exit(1);
}

console.log(`[check-esm] OK — ${checked} relative import(s) resolve to files under ${path.relative(process.cwd(), root) || root}`);
