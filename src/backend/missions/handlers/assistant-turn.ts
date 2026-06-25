/**
 * assistant_turn mission handler — the ONLY mission kind that calls a model,
 * costs tokens, and can mutate a repo (the agent may edit files and commit on
 * a branch). Mandatory guardrails:
 *
 * 1. NEXUS SELF-REFUSAL: refuses to run the agent on the Nexus checkout itself
 *    or any directory nested inside it.
 * 2. HONOR ABORT WITHOUT THROWING: respects AbortSignal via session.abort() and
 *    an abort listener; never throws on abort — always returns a failed outcome.
 * 3. REAL TOKEN USAGE: reports the per-turn input+output token delta (via
 *    `getSessionStats()`) as `tokensUsed`, so the runner's accumulation in
 *    `mission.tokens_used` reflects real cumulative spend toward `max_tokens`
 *    rather than end-of-turn context-window occupancy.
 * 4. NEVER AUTO-MERGES/PUSHES: the handler NEVER merges branches, pushes
 *    commits, or creates PRs — that is out of scope for v1 and left to a human
 *    or a later task.
 */

import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { MissionHandler, MissionRunOutcome } from '../types.js';

// ── safeSessionStats — reads the per-turn cumulative token counters ──────────

type SessionStatsTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
type SessionStats = { tokens: SessionStatsTokens };

function safeSessionStats(session: Partial<Pick<AgentSession, 'getSessionStats'>>): SessionStats | undefined {
  if (typeof session.getSessionStats !== 'function') return undefined;
  try {
    return session.getSessionStats() as SessionStats;
  } catch (err: any) {
    console.error('[missions] getSessionStats failed:', err?.message);
    return undefined;
  }
}

function spendDelta(before: SessionStats | undefined, after: SessionStats | undefined): number {
  // getSessionStats() returns cumulative counters for the whole session.
  // The per-turn spend is the delta across prompt(); we report input+output
  // (cache reads/writes are prompt-cache plumbing, not billable spend here).
  const a = after?.tokens;
  const b = before?.tokens;
  if (!a) return 0;
  const inputDelta = Math.max(0, a.input - (b?.input ?? 0));
  const outputDelta = Math.max(0, a.output - (b?.output ?? 0));
  return inputDelta + outputDelta;
}

// ── Nexus self-guard helper ───────────────────────────────────────────────────

/**
 * Returns true if `dir` IS the Nexus checkout or is nested inside it.
 * Detection: walk up the directory tree; a directory is considered "Nexus" when
 * ALL of:
 *   - src/memory-daemon subdirectory exists
 *   - electron subdirectory exists
 *   - package.json exists and has name === 'nexus'
 */
function isInsideNexus(dir: string): boolean {
  let current = dir;
  while (true) {
    if (
      existsSync(join(current, 'src/memory-daemon')) &&
      existsSync(join(current, 'electron'))
    ) {
      // Check package.json name field
      try {
        const pkgPath = join(current, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
          if (pkg?.name === 'nexus') {
            return true;
          }
        }
      } catch {
        // malformed package.json — not conclusive, skip
      }
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return false;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export const assistantTurnHandler: MissionHandler = async (ctx): Promise<MissionRunOutcome> => {
  const { db, mission, signal, deps } = ctx;

  // 1. Parse config
  let config: { prompt?: string; thread_id?: string } = {};
  try {
    config = JSON.parse(mission.config_json || '{}');
  } catch {
    return { status: 'failed', summary: 'malformed config_json', error: 'malformed config_json' };
  }

  if (!config.prompt) {
    return {
      status: 'failed',
      summary: 'assistant_turn mission has no prompt',
      error: 'assistant_turn mission has no prompt',
    };
  }

  // 2. Look up repo_path
  const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(mission.project_id) as
    | { repo_path: string }
    | undefined;
  const repoPath = project?.repo_path;

  if (!repoPath) {
    return { status: 'failed', summary: 'project has no repo_path', error: 'project has no repo_path' };
  }

  // 3. Nexus self-guard — resolve to an absolute real path
  let resolvedRepoPath: string;
  try {
    resolvedRepoPath = realpathSync(repoPath);
  } catch {
    resolvedRepoPath = resolvePath(repoPath);
  }

  if (isInsideNexus(resolvedRepoPath)) {
    return {
      status: 'failed',
      summary: 'refusing to run agent on Nexus itself',
      error: 'refusing to run agent on Nexus itself',
    };
  }

  // 4. Abort pre-check
  if (signal.aborted) {
    return { status: 'failed', summary: 'aborted before start', error: 'aborted' };
  }

  // 5. Check pi runtime
  if (!deps.pi) {
    return { status: 'failed', summary: 'pi runtime not available', error: 'pi runtime not available' };
  }

  const pi = deps.pi;
  const concurrency = deps.concurrency;

  // 6. Thread ID — stable across iterations for session continuity
  const threadId = config.thread_id || `mission-${mission.id}`;

  // 7. Concurrency claim — project-wide.
  //
  // An assistant_turn mission mutates the repo's working tree, so it must
  // hold the project-wide slot. This mutually excludes it with any chat turn
  // on the same project (regardless of model), which is the repo-mutation
  // safety the claim exists to enforce. See project_docs/design/ for the
  // full rationale and the per-model vs. project-wide distinction.
  //
  // We do NOT also claim a per-(project,model) slot: the mission has no
  // resolved model key at claim time (the session uses the pi-default), and
  // the project-wide slot is the correct primitive for working-tree safety.
  let owner: symbol | undefined;
  if (concurrency) {
    owner = concurrency.claimProject(mission.project_id, threadId, mission.title);
    if (owner === undefined) {
      return { status: 'failed', summary: 'project busy with another run', error: 'project busy' };
    }
  }

  let outcome: MissionRunOutcome;
  let session: AgentSession | undefined;

  try {
    // 8. Get or create session
    session = await pi.sessionFor(threadId, resolvedRepoPath);

    // 9. Abort wiring — prompt() has no signal, so we listen and call abort()
    const onAbort = () => {
      void (session as AgentSession).abort?.();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // 10. Snapshot cumulative token counters before the turn so we can
      //     report the per-turn spend delta (issue #96).
      const statsBefore = safeSessionStats(session);

      // 11. Run the prompt
      await session.prompt(config.prompt);

      // 12. Post-prompt: check if aborted after prompt resolved
      if (signal.aborted) {
        outcome = { status: 'failed', summary: 'aborted after turn', error: 'aborted' };
      } else {
        // Per-turn input+output spend delta. Falls back to 0 only if
        // getSessionStats() is unavailable on this pi build.
        const statsAfter = safeSessionStats(session);
        const tokensUsed = spendDelta(statsBefore, statsAfter);
        const intent = config.prompt.length > 200 ? config.prompt.slice(0, 200) + '…' : config.prompt;
        const summary = `assistant turn complete (${tokensUsed} tokens spent)`;
        outcome = {
          status: 'succeeded',
          intent,
          selectedWork: { threadId, repoPath: resolvedRepoPath },
          summary,
          tokensUsed,
        };
      }
    } catch (err: any) {
      // If abort caused the throw, treat as clean failure rather than rethrow
      if (err?.name === 'AbortError' || signal.aborted) {
        outcome = { status: 'failed', summary: 'aborted during turn', error: 'aborted' };
      } else {
        outcome = {
          status: 'failed',
          summary: `assistant turn failed: ${err?.message ?? String(err)}`,
          error: err?.message ?? String(err),
        };
      }
    } finally {
      // 13. Remove abort listener
      signal.removeEventListener('abort', onAbort);
    }
  } finally {
    // 14. Release project-wide concurrency claim on every path
    //     (incl. sessionFor throw and abort).
    if (concurrency && owner !== undefined) {
      concurrency.releaseProject(mission.project_id, owner);
    }
  }

  return outcome;
};
