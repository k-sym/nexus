/**
 * Attention push poller (#477). Ticks only while the backend process runs (a
 * setInterval, not a system cron), like the Jira and Monday polls. Each tick
 * lists the partner's `open` attention items and sends one APNs push per item
 * whose `alert_seq` moved past the stored cursor. The partner already decided
 * what deserves an alert (a create, an explicit renotify, a snooze coming due)
 * and wrote it into `alert_seq`; Nexus only notices the counter move.
 *
 * `open` is the whole push set: a snoozed item re-enters `open` when due and a
 * `resolving` item never alerts. The partner runs its expiry / snooze-due sweep
 * on every list read, so this poll is also what makes a snoozed item alert on
 * time.
 *
 * The tick keeps running when pushes are off (`attention.push: false`) or APNs
 * is unconfigured: the badge sum needs a fresh open count, and the cursor must
 * keep moving so a later `push: true` does not replay the backlog.
 */
import type Database from 'better-sqlite3';
import type { NexusConfig } from '@nexus/shared';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createPartnerClient, type PartnerClient } from '../partner/client.js';
import type { PushMessage } from '../apns/sender.js';

type AttentionConfig = NexusConfig['attention'];

/** The fields of a partner item this poller reads. Everything else passes through untouched. */
interface AttentionItem {
  id: string;
  kind: string;
  title: string;
  why?: string;
  proposed_verb?: string;
  alert_seq: number;
  /** 'notice' | 'action' once the producer sets it (#477 slice 6b); absent = action. */
  category?: string;
  status?: string;
}

/** A notice is, by definition, not an interruption: it never pushes and never
 *  counts on the badge (design D22a). Absent category = action, so today's
 *  producers are unaffected until they say otherwise. */
export function isNotice(item: Pick<AttentionItem, 'category'>): boolean {
  return item.category === 'notice';
}

interface AttentionList {
  items: AttentionItem[];
  open: number;
  alert_seq: number;
}

export interface AttentionPollDeps {
  /** Current partner client, or undefined when the assistant is unconfigured. Re-read each tick. */
  partner: () => PartnerClient | undefined;
  apns: { readonly configured: boolean; notify(message: PushMessage): Promise<void> };
  /** Tool-gate approvals awaiting a decision, for the badge sum. */
  pendingApprovals: () => number;
  /** Test seam; defaults to the live config. */
  config?: () => AttentionConfig;
  log?: (line: string) => void;
}

export interface AttentionTick {
  /** True when the cursor was (re)seeded and nothing pushed. */
  seeded: boolean;
  pushed: number;
  open: number;
  cursor: number;
}

// Last error message logged, per-process: a partner that is down logs once,
// not once a minute (the monday/poll.ts idiom).
let lastErrorMessage: string | null = null;

/** Test-only: clear the deduped-error state. */
export function __resetPollErrorState(): void {
  lastErrorMessage = null;
}

export function readCursor(db: Database.Database): number | null {
  const row = db.prepare('SELECT last_alert_seq FROM attention_push_cursor WHERE id = 1').get() as
    { last_alert_seq: number } | undefined;
  return row ? row.last_alert_seq : null;
}

export function writeCursor(db: Database.Database, seq: number): void {
  db.prepare(
    `INSERT INTO attention_push_cursor (id, last_alert_seq, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_alert_seq = excluded.last_alert_seq, updated_at = excluded.updated_at`,
  ).run(seq, new Date().toISOString());
}

const KIND_LABELS: Record<string, string> = {
  'mail.waiting': 'Mail waiting',
  'mail.urgent': 'Urgent mail',
  'draft.pending': 'Draft pending',
  'meeting.prep': 'Meeting prep',
  'quiz.prep': 'Quiz prep',
  'quiz.harvest': 'Quiz harvest',
  'autonomy.proposal': 'Autonomy proposal',
};

const VERB_LABELS: Record<string, string> = {
  draft: 'Draft',
  open: 'Open',
  snooze: 'Snooze',
  dismiss: 'Dismiss',
};

/** Lead with the verb and the thing (#391): the lock screen is where the decision
 * is weighed. Clipped so a long model-written `why` cannot flood the banner. */
export function pushFor(item: AttentionItem, badge: number): PushMessage {
  const verb = item.proposed_verb ? VERB_LABELS[item.proposed_verb] ?? item.proposed_verb : undefined;
  const lead = verb ? `${verb}? ${item.title}` : item.title;
  const body = (item.why ? `${lead} · ${item.why}` : lead).slice(0, 120);
  return {
    title: `Needs you — ${KIND_LABELS[item.kind] ?? item.kind}`,
    body,
    deepLink: `attention:${item.id}`,
    threadId: `attention:${item.kind}`,
    badge,
  };
}

/**
 * Run one tick. Returns what happened, or null when dormant (no partner) or
 * when the list failed (logged once per distinct message). Never throws.
 */
export async function runAttentionPollOnce(db: Database.Database, deps: AttentionPollDeps): Promise<AttentionTick | null> {
  const partner = deps.partner();
  if (!partner) return null;
  const cfg = (deps.config ?? (() => loadConfig().attention))();
  const log = deps.log ?? ((line: string) => console.log(line));

  let list: AttentionList;
  try {
    const body = (await partner.listAttention('open')) as Partial<AttentionList> | undefined;
    list = {
      items: Array.isArray(body?.items) ? (body!.items as AttentionItem[]) : [],
      open: typeof body?.open === 'number' ? body.open : 0,
      alert_seq: typeof body?.alert_seq === 'number' ? body.alert_seq : 0,
    };
    lastErrorMessage = null;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (lastErrorMessage !== message) {
      lastErrorMessage = message;
      log(`[attention] list failed — ${message}`);
    }
    return null;
  }

  const cursor = readCursor(db);
  // Cold start seeds silently: the first deploy must not fire a push per
  // existing item. A counter below the cursor means the partner's store was
  // reset; re-seed rather than stay mute until it catches up.
  if (cursor == null || list.alert_seq < cursor) {
    writeCursor(db, list.alert_seq);
    log(cursor == null
      ? `[attention] cursor seeded at alert_seq ${list.alert_seq} — no pushes for the existing backlog`
      : `[attention] partner alert_seq ${list.alert_seq} is below the cursor ${cursor} — counter reset, re-seeded`);
    return { seeded: true, pushed: 0, open: list.items.filter((item) => !isNotice(item)).length, cursor: list.alert_seq };
  }

  // The badge and the pushes count actions only (D22a). The list is `open`
  // items, so open actions = the items minus notices.
  const openActions = list.items.filter((item) => !isNotice(item)).length;
  let pushed = 0;
  if (cfg.push && deps.apns.configured) {
    const badge = deps.pendingApprovals() + openActions;
    const due = list.items.filter((item) => typeof item.alert_seq === 'number' && item.alert_seq > cursor && !isNotice(item));
    for (const item of due) {
      await deps.apns.notify(pushFor(item, badge));
      pushed += 1;
    }
  }
  writeCursor(db, list.alert_seq);
  return { seeded: false, pushed, open: openActions, cursor: list.alert_seq };
}

export interface AttentionPoll {
  stop: () => void;
  /** Open items as of the last successful tick; 0 before the first. */
  openCount: () => number;
}

/** Live partner client from config, or undefined when the assistant is unconfigured. */
export function partnerFromConfig(config: NexusConfig = loadConfig()): PartnerClient | undefined {
  const url = resolveEnvVars(config.assistant.url || '').trim();
  const key = resolveAssistantKey(config);
  if (!url || !key) return undefined;
  return createPartnerClient({ url, key });
}

/**
 * Start the poll: tick now, then every `attention.poll_minutes` (floor 1),
 * re-reading config each tick so a cadence or push change needs no restart.
 * Dormant with one log line when the assistant is unconfigured at start.
 */
export function startAttentionPoll(db: Database.Database, deps: AttentionPollDeps): AttentionPoll {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (!deps.partner()) {
    log('[attention] assistant not configured — poll dormant');
    return { stop: () => {}, openCount: () => 0 };
  }
  const config = deps.config ?? (() => loadConfig().attention);
  let open = 0;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async () => {
    const result = await runAttentionPollOnce(db, { ...deps, config, log });
    if (result) open = result.open;
    if (stopped) return;
    // setTimeout, not setInterval: the cadence is re-read after every tick.
    handle = setTimeout(() => void tick(), Math.max(1, config().poll_minutes) * 60_000);
  };
  log(`[attention] poll started — every ${Math.max(1, config().poll_minutes)}m, push ${config().push ? 'on' : 'off'}`);
  void tick();

  return {
    stop: () => {
      stopped = true;
      if (handle) clearTimeout(handle);
    },
    openCount: () => open,
  };
}
