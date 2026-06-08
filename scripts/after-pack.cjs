/**
 * electron-builder afterPack hook.
 *
 * File copies into the packaged Resources tree can drop the execute bit, so we
 * restore it on the bundled node and node-pty's spawn-helper, then smoke-test
 * that better-sqlite3 actually loads under the bundled node — so a broken
 * package fails the build here, not on the user's machine at launch.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const isMac = packager.platform.name === 'mac';
  const resources = isMac
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');

  const services = path.join(resources, 'services');
  const nodeBin =
    process.platform === 'win32'
      ? path.join(resources, 'node', 'node.exe')
      : path.join(resources, 'node', 'bin', 'node');

  const chmodx = (p) => {
    try {
      const s = fs.statSync(p);
      fs.chmodSync(p, s.mode | 0o111);
    } catch {
      /* not present on this platform */
    }
  };

  chmodx(nodeBin);

  const prebuilds = path.join(services, 'backend', 'node_modules', 'node-pty', 'prebuilds');
  try {
    for (const plat of fs.readdirSync(prebuilds)) chmodx(path.join(prebuilds, plat, 'spawn-helper'));
  } catch {
    /* no node-pty prebuilds */
  }

  // Smoke-test better-sqlite3 under the bundled node (the ABI that will run it).
  try {
    execFileSync(nodeBin, ['-e', 'new (require("better-sqlite3"))(":memory:").close()'], {
      cwd: path.join(services, 'backend'),
      stdio: 'inherit',
    });
    console.log('[after-pack] better-sqlite3 loads under bundled node ✓');
  } catch (err) {
    throw new Error(`[after-pack] better-sqlite3 failed to load under bundled node: ${err.message}`);
  }
};
