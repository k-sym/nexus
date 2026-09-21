/**
 * Side-effect import: points this test process at a private, empty NEXUS_HOME.
 *
 * Route modules call loadConfig(), which otherwise reads the developer's real
 * ~/.nexus/config.yaml — e.g. `roles.enabled: true` makes registerChatRoutes
 * build a RoleRunner that queries role_runs on an in-memory test db without
 * that table. Import this FIRST in any test file that registers routes or
 * otherwise reaches loadConfig(), so nothing resolves a config path before it
 * runs. `node --test` runs each file in its own process, so the scratch dir is
 * per-file, and it deliberately replaces any NEXUS_HOME the caller exported.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-test-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
process.on('exit', () => rmSync(NEXUS_HOME, { recursive: true, force: true }));

export { NEXUS_HOME };
