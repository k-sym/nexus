/**
 * Point `../config` at a private tmpdir instead of the developer's real
 * `~/.nexus`, for any test that calls `saveConfig` (directly, or via a local
 * `withMondayEnabled` helper).
 *
 * MUST be the first import statement in any test file that imports, or
 * transitively depends on, `../config`. config.ts resolves `NEXUS_DIR` from
 * `process.env.NEXUS_DIR` exactly once, in a top-level const, at module
 * load time. Under real ESM (this package is `"type": "module"`), a plain
 * `process.env.NEXUS_DIR = ...` statement written ABOVE an `import ...` line
 * does NOT run first: the JS engine evaluates a file's own imports — in the
 * order they're written, depth-first — to completion before executing any
 * of that file's own top-level statements, regardless of where those
 * statements sit in the source text. (Verified empirically with tsx; see
 * .superpowers/sdd/config-isolation-report.md.) Importing this module first
 * sidesteps the trap: as a dependency in its own right, its top-level code
 * — which sets the env var — is guaranteed to finish before the importing
 * file reaches any later import (e.g. `../config`, `../db`, `../monday/*`,
 * `../routes/*`) that would otherwise resolve NEXUS_DIR too early.
 *
 * node's test runner spawns one process per test file when given multiple
 * files (confirmed empirically), so each file that imports this module gets
 * its own independent `mkdtempSync` call and thus its own private
 * directory — no cross-file race, and nothing here to corrupt the real
 * `~/.nexus/config.yaml`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NEXUS_TEST_DIR = mkdtempSync(join(tmpdir(), 'nexus-test-'));
process.env.NEXUS_DIR = NEXUS_TEST_DIR;

// Best-effort cleanup; harmless if it doesn't run (CI/dev machines already
// clear os.tmpdir() periodically, and each dir is process-unique).
process.once('exit', () => {
  rmSync(NEXUS_TEST_DIR, { recursive: true, force: true });
});
