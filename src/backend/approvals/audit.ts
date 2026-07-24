/**
 * The tool-decision audit trail (#281 part 2).
 *
 * Every gated tool call produces a record: what tool, a summary of its input,
 * the policy decision and *why* (which rule / category / the Supervise floor),
 * the final outcome, and how it was reached (auto by policy, by a human, a
 * timeout, or an abort). The closing note on #266 asked specifically for the
 * decision AND its source — for a feature whose point is controlled host
 * access, "allowed, no record of what or why" is the real gap this closes.
 *
 * Recording is best-effort by contract: a write that fails must never break the
 * tool call it was describing.
 */
import type Database from 'better-sqlite3';
import type { ToolCategory, ToolDecision, ToolDecisionSource } from '../pi/tool-policy.js';

/** How a gated call was ultimately settled. */
export type ToolDecisionAnsweredBy = 'policy' | 'human' | 'timeout' | 'aborted';

export interface ToolDecisionRecord {
  threadId: string;
  cwd: string;
  toolName: string;
  category: ToolCategory;
  /** A short, bounded description of the call's input (never the raw payload). */
  inputSummary: string;
  /** The policy's verdict: allow, confirm, or deny. */
  decision: ToolDecision;
  /** What produced that verdict. */
  source: ToolDecisionSource;
  /** The rule that decided, when `source` involved one. */
  ruleTool?: string;
  ruleWhen?: string;
  /** Whether the call ran in the end. A `confirm` becomes allowed or denied
   *  once answered; `allow`/`deny` are immediate. */
  outcome: 'allowed' | 'denied';
  /** How the outcome was reached. `policy` = decided without a human (allow or
   *  a policy deny); the rest apply to a parked `confirm`. */
  answeredBy: ToolDecisionAnsweredBy;
}

/** Where the approval extension sends records. Kept minimal so it's trivial to
 *  stub in tests and so a no-op implementation costs nothing. */
export interface ApprovalAudit {
  record(entry: ToolDecisionRecord): void;
}

/** A sink that discards records — for sessions/tests with no audit backend. */
export const NULL_APPROVAL_AUDIT: ApprovalAudit = { record() { /* no-op */ } };

/** Cap on a stored input summary. Long enough to be useful, short enough that
 *  the audit table can't be bloated by one enormous tool input. */
export const MAX_INPUT_SUMMARY = 300;

/**
 * A short, human-readable summary of a tool call's input — never the raw
 * payload. Pulls the field that carries the intent when the shape is known
 * (command, url, file path, …), else compact JSON, always bounded. Never
 * throws: an unrenderable input becomes an empty summary, not a failed record.
 */
export function summarizeToolInput(input: unknown): string {
  const clamp = (s: string) => (s.length > MAX_INPUT_SUMMARY ? `${s.slice(0, MAX_INPUT_SUMMARY - 1)}…` : s);
  if (typeof input === 'string') return clamp(input);
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const field of ['command', 'url', 'file_path', 'path', 'action', 'query', 'pattern']) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return clamp(value.trim());
  }
  try {
    return clamp(JSON.stringify(input));
  } catch {
    return '';
  }
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS tool_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    cwd TEXT NOT NULL DEFAULT '',
    tool_name TEXT NOT NULL,
    category TEXT NOT NULL,
    input_summary TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL,
    source TEXT NOT NULL,
    rule_tool TEXT,
    rule_when TEXT,
    outcome TEXT NOT NULL,
    answered_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

/**
 * A DB-backed audit sink. The table is created on construction so the sink is
 * self-contained. Writes are wrapped: a logging failure is swallowed, because
 * the record describes a tool call that has already been decided — losing the
 * record must not change what happens to the call.
 */
export class DbApprovalAudit implements ApprovalAudit {
  private readonly insert: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(CREATE_TABLE);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tool_decisions_created ON tool_decisions(created_at DESC)');
    this.insert = db.prepare(`
      INSERT INTO tool_decisions
        (thread_id, cwd, tool_name, category, input_summary, decision, source, rule_tool, rule_when, outcome, answered_by, created_at)
      VALUES
        (@threadId, @cwd, @toolName, @category, @inputSummary, @decision, @source, @ruleTool, @ruleWhen, @outcome, @answeredBy, @createdAt)
    `);
  }

  record(entry: ToolDecisionRecord): void {
    try {
      this.insert.run({
        threadId: entry.threadId,
        cwd: entry.cwd,
        toolName: entry.toolName,
        category: entry.category,
        inputSummary: entry.inputSummary,
        decision: entry.decision,
        source: entry.source,
        ruleTool: entry.ruleTool ?? null,
        ruleWhen: entry.ruleWhen ?? null,
        outcome: entry.outcome,
        answeredBy: entry.answeredBy,
        createdAt: new Date().toISOString(),
      });
    } catch {
      /* the call was already decided; a lost audit row must not affect it */
    }
  }

  /** Most-recent decisions first, for the audit view. */
  list(limit = 100): ToolDecisionRow[] {
    try {
      return this.db
        .prepare('SELECT * FROM tool_decisions ORDER BY id DESC LIMIT ?')
        .all(Math.max(1, Math.min(1000, limit))) as ToolDecisionRow[];
    } catch {
      return [];
    }
  }
}

/** A stored row, as returned to the audit endpoint. */
export interface ToolDecisionRow {
  id: number;
  thread_id: string;
  cwd: string;
  tool_name: string;
  category: string;
  input_summary: string;
  decision: string;
  source: string;
  rule_tool: string | null;
  rule_when: string | null;
  outcome: string;
  answered_by: string;
  created_at: string;
}
