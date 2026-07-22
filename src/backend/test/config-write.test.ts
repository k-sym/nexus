import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseConfigYaml, saveConfig } from '../config';

// Scratch config tree, as in config-home.test.ts — these tests write config.yaml
// and must never touch the developer's real ~/.nexus.
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-config-write-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

test('parseConfigYaml treats an empty config.yaml as no overrides rather than throwing', () => {
  // js-yaml 5 throws "expected a document, but the input is empty" where js-yaml
  // 4 returned undefined, so the `|| {}` fallback alone no longer covers it.
  assert.deepEqual(parseConfigYaml(''), {});
  assert.deepEqual(parseConfigYaml('   \n'), {});
});

test('parseConfigYaml still throws on a malformed config.yaml', () => {
  // Defaulting silently would let the next save overwrite a corrupt but
  // recoverable config with defaults.
  assert.throws(() => parseConfigYaml('assistant:\n  url: "unterminated'));
});

test('loadConfig falls back to defaults when config.yaml is empty', () => {
  const original = loadConfig();
  try {
    writeFileSync(join(NEXUS_HOME, 'config.yaml'), '', 'utf-8');
    assert.equal(loadConfig().server.port, original.server.port);
  } finally {
    saveConfig(original);
  }
});
