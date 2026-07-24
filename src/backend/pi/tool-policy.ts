/**
 * Tool policy — decides what happens to a tool call *before* it runs.
 *
 * This replaces the old boolean "is this thread supervised?" question with a
 * three-way decision per (toolName, input):
 *
 *   - `allow`   — run it, no prompt. The default for read-only work.
 *   - `confirm` — park it on the ApprovalBroker and wait for a human.
 *   - `deny`    — refuse outright with a reason. No round trip, no waiting.
 *
 * The motivation is that Supervise is all-or-nothing: a supervised thread gates
 * every tool call and an unsupervised one gates none. That is unusable once
 * tools with real host side effects exist (see #264 local Docker services and
 * #265 browser automation) — the only two options would be ungated host access
 * or confirming every `grep`.
 *
 * ## Precedence
 *
 * Sources are consulted in order and the FIRST one with an opinion wins:
 *
 *   1. the built-in ungated set (`question`, which owns its own interactive
 *      path and would double-prompt or deadlock if gated here)
 *   2. the per-thread override — what Supervise is today
 *   3. the category policy — per-project/global config in a later phase
 *   4. the built-in category defaults
 *
 * with one exception: **`deny` is a floor**. A source that denies cannot be
 * downgraded to `confirm`/`allow` by a lower-precedence source, so a policy can
 * take a capability off the table without a later layer quietly handing it back.
 *
 * ## Phase 1 scope
 *
 * `DEFAULT_CATEGORY_POLICY` allows every category, so behaviour is byte-for-byte
 * what it was before: unsupervised threads gate nothing, supervised threads
 * confirm everything except `question`. The classification and the plumbing land
 * now so that #264/#265 can ship a tool in a side-effectful category and give it
 * a `confirm` default without touching the approval path again.
 */

// `ToolDecision`/`ToolCategory` live in @nexus/shared so the config block can
// reference them; the classification logic and defaults stay here. `unknown`
// (anything unclassified) is treated as side-effectful, so a broken policy
// fails closed around it rather than waving it through.
import type { ToolDecision, ToolCategory, ToolPolicyRule } from '@nexus/shared';
import { evaluateCondition } from './tool-policy-conditions.js';

export type { ToolDecision, ToolCategory, ToolPolicyRule } from '@nexus/shared';

export type CategoryPolicy = Partial<Record<ToolCategory, ToolDecision>>;

export interface ToolPolicyRequest {
  toolName: string;
  input: unknown;
}

/** Where a decision came from, for the audit trail (#281 part 2). `supervise`
 *  means the per-thread confirm-everything floor raised whatever the base was. */
export type ToolDecisionSource = 'ungated' | 'rule' | 'category' | 'default' | 'supervise';

/** A decision plus why — what layer produced it, and the rule when a rule did. */
export interface ToolDecisionTrace {
  decision: ToolDecision;
  source: ToolDecisionSource;
  /** Present when `source` is `rule` (or a rule was raised by `supervise`). */
  rule?: { tool: string; when?: string };
}

/** Resolves a decision for one tool call. Read live at each call — never frozen
 *  into a session — so a policy change takes effect on the next tool call
 *  without rebuilding the session. `explain` returns the same decision with its
 *  source, for auditing; it is optional so a plain function still satisfies the
 *  type. */
export interface ToolPolicyResolver {
  (request: ToolPolicyRequest): ToolDecision;
  explain?(request: ToolPolicyRequest): ToolDecisionTrace;
}

/** The built-in `question` tool has its own interactive glasses approval path
 *  (see ./questions.ts). Gating it here would double-prompt / deadlock, so it is
 *  always excluded from the gate, at the highest precedence. */
export const UNGATED_TOOL_NAMES = new Set(['question']);

/**
 * Built-in classification. Names match Pi's core tools (`bash`, `edit`, `read`,
 * … — see the SDK's `core/tools/`) plus the tools Nexus registers itself.
 * Anything absent is `unknown`, deliberately.
 */
const TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  question: 'interactive',

  read: 'read',
  ls: 'read',
  grep: 'read',
  find: 'read',
  memory_recall: 'read',
  monday_search: 'read',
  monday_get_item: 'read',

  edit: 'write',
  write: 'write',
  monday_post_update: 'network',

  bash: 'exec',
  docker_service: 'services',

  // Navigation is the act with an external effect; reading a page already
  // loaded is just a read. Splitting them means a policy can gate where the
  // browser may GO without gating every look at the result.
  browser_navigate: 'network',
  browser_act: 'network',
  browser_read: 'read',
  browser_diagnostics: 'read',
  browser_screenshot: 'read',
};

/** Categories whose tools can affect something outside the model's context —
 *  the host, the repo, or a remote service. Used for fail-closed behaviour. */
const SIDE_EFFECTFUL: ReadonlySet<ToolCategory> = new Set<ToolCategory>([
  'write', 'exec', 'services', 'network', 'unknown',
]);

/**
 * Built-in defaults.
 *
 * Everything Nexus shipped before the policy layer is `allow`, so introducing
 * it changed no existing thread's behaviour.
 *
 * `services` is the exception, and the first use of what the layer was built
 * for: starting containers binds host ports and can mount host paths, so
 * `docker_service` asks before it acts. This is not a behaviour change either —
 * nothing was in `services` until #264 added the tool — and it costs an
 * unsupervised thread nothing, because the tool is omitted entirely unless
 * Docker is reachable and the project opted in.
 *
 * A later phase makes this configurable per project.
 */
export const DEFAULT_CATEGORY_POLICY: CategoryPolicy = {
  interactive: 'allow',
  read: 'allow',
  write: 'allow',
  exec: 'allow',
  services: 'confirm',
  network: 'allow',
  unknown: 'allow',
};

export function categorizeTool(toolName: string): ToolCategory {
  return TOOL_CATEGORIES[toolName] ?? 'unknown';
}

export function isSideEffectful(toolName: string): boolean {
  return SIDE_EFFECTFUL.has(categorizeTool(toolName));
}

/** The decision a failure falls back to. Side-effectful tools fail closed;
 *  read-only ones stay allowed so a broken policy cannot wedge every `grep`. */
export function failClosedDecision(toolName: string): ToolDecision {
  return isSideEffectful(toolName) ? 'confirm' : 'allow';
}

const RANK: Record<ToolDecision, number> = { allow: 0, confirm: 1, deny: 2 };

/** Apply the "deny is a floor" rule: never return something weaker than a
 *  decision an earlier source already reached. */
function atLeast(decision: ToolDecision, floor: ToolDecision | undefined): ToolDecision {
  if (!floor) return decision;
  return RANK[decision] >= RANK[floor] ? decision : floor;
}

export interface ToolPolicyOptions {
  /** The per-thread override. `true` ⇒ confirm everything gateable, which is
   *  exactly what Supervise means today. Read live at each tool call. */
  isSupervised?: () => boolean;
  /** Category-level policy. Merged over `DEFAULT_CATEGORY_POLICY`, sourced from
   *  per-project and global config. Read live, so a config change lands on the
   *  next tool call. */
  categoryPolicy?: () => CategoryPolicy;
  /** Input-aware rules, more specific than a category. The first rule that
   *  matches the tool (and whose named condition holds) sets the base decision.
   *  Read live, same as the category policy. */
  rules?: () => ToolPolicyRule[];
}

const DECISIONS: ReadonlySet<string> = new Set<ToolDecision>(['allow', 'confirm', 'deny']);

/**
 * The first rule that applies to this request, or `undefined` when none do. A
 * rule applies when its `tool` matches and either it has no `when` or its named
 * condition evaluates true. Malformed rules and unknown conditions are skipped —
 * a rule never applies "blindly".
 */
function matchingRule(rules: ToolPolicyRule[], request: ToolPolicyRequest): ToolPolicyRule | undefined {
  for (const rule of rules) {
    if (!rule || rule.tool !== request.toolName || !DECISIONS.has(rule.decision)) continue;
    if (!rule.when) return rule; // unconditional rule for this tool
    // Unknown condition (undefined) or false → this rule does not apply; try the next.
    if (evaluateCondition(rule.when, request) === true) return rule;
  }
  return undefined;
}

/**
 * Resolve a request to a decision AND its source.
 *
 * Precedence for the base decision, most specific first: a matching input-aware
 * rule → the category policy → the fail-closed default. The Supervise override
 * is then a floor that can only *raise* that base (allow→confirm), never lower
 * it; when it does raise, the effective source is `supervise`. An explicit
 * `deny` is never softened.
 */
function explainDecision(options: ToolPolicyOptions, request: ToolPolicyRequest): ToolDecisionTrace {
  const { toolName } = request;
  // Highest precedence and not overridable: gating this deadlocks the thread.
  if (UNGATED_TOOL_NAMES.has(toolName)) return { decision: 'allow', source: 'ungated' };

  const floor: ToolDecision | undefined = options.isSupervised?.() ? 'confirm' : undefined;

  const rule = matchingRule(options.rules?.() ?? [], request);
  const policy = { ...DEFAULT_CATEGORY_POLICY, ...(options.categoryPolicy?.() ?? {}) };
  const category = categorizeTool(toolName);

  let base: ToolDecision;
  let source: ToolDecisionSource;
  if (rule) { base = rule.decision; source = 'rule'; }
  else if (policy[category] !== undefined) { base = policy[category] as ToolDecision; source = 'category'; }
  else { base = failClosedDecision(toolName); source = 'default'; }

  const decision = atLeast(base, floor);
  const ruleInfo = rule ? { tool: rule.tool, ...(rule.when ? { when: rule.when } : {}) } : undefined;
  // If the Supervise floor changed the outcome, that floor is what decided.
  if (decision !== base) return { decision, source: 'supervise', ...(ruleInfo ? { rule: ruleInfo } : {}) };
  return { decision, source, ...(ruleInfo ? { rule: ruleInfo } : {}) };
}

/**
 * Build the resolver a session's approval extension consults.
 *
 * Every input is a getter rather than a value, because the property that makes
 * mid-session Supervise toggling (and a live config edit) work — the decision is
 * computed at tool-call time, not captured at session build — has to survive.
 * The returned resolver also carries `explain` for the audit trail.
 */
export function createToolPolicyResolver(options: ToolPolicyOptions = {}): ToolPolicyResolver {
  const resolver = ((request) => explainDecision(options, request).decision) as ToolPolicyResolver;
  resolver.explain = (request) => explainDecision(options, request);
  return resolver;
}

/**
 * Evaluate a resolver without letting it break the turn.
 *
 * A resolver reads config and may one day evaluate user-authored rules, so it
 * can throw or return nonsense. Neither may result in a side-effectful tool
 * running unreviewed — the requirement is to fail *closed*, not to fail open
 * and hope. A malformed decision is treated exactly like a thrown one.
 */
export function resolveToolDecision(
  resolver: ToolPolicyResolver,
  request: ToolPolicyRequest,
): ToolDecision {
  // Still honoured on the failure path: an ungated tool must never end up
  // parked on a gate just because the policy blew up.
  if (UNGATED_TOOL_NAMES.has(request.toolName)) return 'allow';
  try {
    const decision = resolver(request);
    if (decision === 'allow' || decision === 'confirm' || decision === 'deny') return decision;
    return failClosedDecision(request.toolName);
  } catch {
    return failClosedDecision(request.toolName);
  }
}
