/**
 * Availability gate for live integration tests.
 *
 * These suites drive real external tools — a Docker daemon, a Chromium-family
 * browser — so they cannot run everywhere. The gate has two jobs:
 *
 *   - **Locally**, a developer without Docker or a browser running should get a
 *     clean skip, not a wall of red. `npm run test:live` on a laptop with
 *     neither tool present passes, having run nothing.
 *
 *   - **In CI**, a skip must not masquerade as a pass. The integration workflow
 *     sets `NEXUS_REQUIRE_LIVE=1`; under it, an unavailable tool registers a
 *     *failing* guard test, so a broken browser-install step or a stopped
 *     daemon turns the job red instead of quietly green. A silent skip is the
 *     one outcome an integration gate must never produce.
 *
 * The tool probes live in the product code (`docker/compose.ts`,
 * `browser/discover.ts`); this only decides what to do with their answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** CI opt-in. When set, an unavailable tool is a failure, not a skip. */
export const REQUIRE_LIVE = Boolean(process.env.NEXUS_REQUIRE_LIVE);

/**
 * Turn an availability answer into a node:test `skip` value.
 *
 * Returns `false` (run) when available. When not, returns a skip reason — and,
 * if `NEXUS_REQUIRE_LIVE` is set, also registers a standalone failing test so
 * the absence is loud. The suite itself still skips either way; the guard test
 * is what carries the CI failure.
 */
export function liveSkip(tool: string, available: boolean, detail: string): boolean | string {
  if (available) return false;

  if (REQUIRE_LIVE) {
    test(`[live] ${tool} is available`, () => {
      assert.fail(
        `${tool} is required in this environment (NEXUS_REQUIRE_LIVE is set) but was not available: ${detail}`,
      );
    });
    return `${tool} unavailable: ${detail}`;
  }

  return `${tool} unavailable: ${detail} — set NEXUS_REQUIRE_LIVE=1 to fail instead of skip`;
}
