import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDbPath, getNexusDir, loadConfig, saveConfig } from '../config';

// Injectable config location. Without it, any test that writes config would
// clobber the developer's real ~/.nexus/config.yaml and leak into the other
// test files, which `node --test` runs as parallel processes.
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-config-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

test('NEXUS_HOME relocates the config tree away from ~/.nexus', () => {
  assert.equal(getNexusDir(), NEXUS_HOME);
  assert.equal(getDbPath(), join(NEXUS_HOME, 'nexus.db'));

  // First load on an empty root writes the defaults there…
  const config = loadConfig();
  assert.equal(existsSync(join(NEXUS_HOME, 'config.yaml')), true);
  // …including the Obsidian vault, so nothing is created in the real home.
  assert.equal(config.obsidian.vault_path.startsWith(NEXUS_HOME), true);
  assert.equal(config.obsidian.vault_path.startsWith(join(homedir(), 'Obsidian')), false);

  saveConfig({ ...config, server: { ...config.server, token: 'scratch-only' } });
  assert.match(readFileSync(join(NEXUS_HOME, 'config.yaml'), 'utf-8'), /scratch-only/);
  assert.equal(loadConfig().server.token, 'scratch-only');
});

// saveConfig writes to a sibling temp file and renames it into place, so a
// concurrent reader never sees a half-written config. The temp file must not
// survive the rename.
test('saveConfig leaves no temp file behind', () => {
  saveConfig(loadConfig());
  assert.deepEqual(readdirSync(NEXUS_HOME).filter((f) => f.includes('.tmp')), []);
});
