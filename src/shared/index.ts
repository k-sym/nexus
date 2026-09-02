/**
 * Shared types for the Nexus backend and frontend.
 *
 * The chat runtime is now the pi-coding-agent SDK; persona/provider/PTY
 * surfaces are gone. Only the types the new code paths still need are
 * exported.
 */

export type TaskStatus = 'triage' | 'todo' | 'in_progress' | 'review' | 'deploy';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** Max characters in a project rail badge. */
export const PROJECT_BADGE_MAX_LENGTH = 3;

/** Connector words that shouldn't win an initial in a derived badge. */
const BADGE_STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by']);

/**
 * Default rail badge for a project name: up to three characters, uppercase.
 *
 * Multi-word names collapse to initials ("United States of America" -> USA,
 * connector words ignored); a single word takes its first three letters
 * ("Nexus" -> NEX). Two-word names legitimately yield two characters. This is
 * only a starting point — the badge is user-editable, so a name whose initials
 * read badly can be fixed by hand rather than by a cleverer rule here.
 */
export function deriveProjectBadge(name: string): string {
  const words = name.match(/[a-z0-9]+/gi) ?? [];
  if (words.length === 0) return '?';
  // Drop connectors only while at least two real words survive, so "Of Mice"
  // doesn't strip itself down to nothing.
  const significant = words.filter((w) => !BADGE_STOPWORDS.has(w.toLowerCase()));
  const chosen = significant.length >= 2 ? significant : words;
  if (chosen.length >= 2) {
    return chosen.slice(0, PROJECT_BADGE_MAX_LENGTH).map((w) => w[0]).join('').toUpperCase();
  }
  return chosen[0].slice(0, PROJECT_BADGE_MAX_LENGTH).toUpperCase();
}

/**
 * Coerce user input into a storable badge, falling back to the derived value
 * when the field is left empty or contains nothing usable.
 */
export function normalizeProjectBadge(value: string | undefined, name = ''): string {
  const cleaned = (value ?? '').replace(/[^a-z0-9]/gi, '').slice(0, PROJECT_BADGE_MAX_LENGTH).toUpperCase();
  return cleaned || deriveProjectBadge(name);
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  /** Up to 3 uppercase chars shown in the project rail; derived from name, user-editable. */
  badge: string;
  /** @deprecated No longer surfaced in the UI — superseded by `badge`. Retained so existing rows keep their data. */
  description: string;
  repo_path: string;
  config_json: string;
  /** Detected `git remote origin` URL of repo_path; '' when none/not a git repo. */
  git_remote: string;
  task_count?: number;
  chat_session_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Persona slug from the legacy persona system. Retained on the row so
   *  legacy data doesn't break; the new orchestrator doesn't read it. */
  assigned_agent: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  /** Model picked when the task was moved to "In Progress" (provider/id).
   *  Seeds the linked chat thread's first turn. */
  model_key: string | null;
  /** The chat thread this task runs in. Set when the task is moved to
   *  "In Progress" and a model is picked; the agent works in that thread
   *  instead of running headlessly. Null for tasks never started. */
  thread_id: string | null;
  /** Source system for an auto-triaged task, e.g. 'github'. Null for manual tasks. */
  external_source: string | null;
  /** Identifier within the source system, e.g. the GitHub issue number as text.
   *  Paired with external_source to dedup re-syncs. Null for manual tasks. */
  external_id: string | null;
}

export interface GitDiffSummary {
  files: number;
  hunks: number;
  added: number;
  deleted: number;
  staged_files: string[];
  unstaged_files: string[];
  untracked_files: string[];
}

export interface GitDiffFile {
  path: string;
  old_path: string | null;
  new_path: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';
  added: number;
  deleted: number;
  staged: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffHunk {
  id: string;
  file: string;
  header: string;
  diff: string;
  prompt: string;
  staged: boolean;
  old_start: number | null;
  new_start: number | null;
  old_lines: number | null;
  new_lines: number | null;
}

export type GitDiffState =
  | {
      ok: true;
      repo_path: string;
      git_remote: string;
      has_changes: boolean;
      summary: GitDiffSummary;
      files: GitDiffFile[];
      hunks: GitDiffHunk[];
    }
  | {
      ok: false;
      reason: 'not_git_repo' | 'git_error';
      message: string;
      repo_path?: string;
      git_remote?: string;
    };

export type ReviewAction = 'ask_reviewer' | 'explain_change' | 'spawn_fix_task' | 'assign_reviewer' | 'attach_to_chat';

export interface ReviewActionRequest {
  task_id?: string;
  action: ReviewAction;
  hunk_id?: string;
  note?: string;
}

export interface ReviewActionResult {
  ok: true;
  action: ReviewAction;
  task?: {
    id: string;
    project_id: string;
    title: string;
    status: TaskStatus;
    assigned_agent: string | null;
    model_key: string | null;
  };
  thread?: {
    id: string;
    project_id: string;
    title: string;
  };
  seed?: {
    threadId: string;
    prompt: string;
    modelKey: string | null;
  };
}

/** A Jira ticket mirrored into Nexus (Jira stays canonical). */
export interface Ticket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  assignee: string | null;
  created: string | null;
  updated: string | null;
  url: string | null;
  source: string | null;
  synced_at: string;
}

/** Cleaned, display-ready body of a Jira ticket, fetched lazily on selection. */
export interface TicketDescription {
  key: string;
  /** Readable plain text: paragraphs separated by blank lines, list items as "• …". Empty string when the ticket has no description. */
  body: string;
  /** Sections pulled out of the body and offered behind a "show more" fold. */
  trimmed: { kind: 'forwarded' | 'footer'; text: string }[];
  /** ISO timestamp the body was last fetched from Jira; null if never fetched. */
  fetchedAt: string | null;
  /** True when Jira returned no description content for this ticket. */
  empty: boolean;
}

/**
 * Idea Watcher (#352) — an idea ripens through a dialogue with the partner
 * assistant before graduating into a project or a GitHub issue set.
 * `parked → discussing → researching → reviewed → graduated | discarded`;
 * the terminal states are soft (rows are kept, not deleted).
 */
export type IdeaState = 'parked' | 'discussing' | 'researching' | 'reviewed' | 'graduated' | 'discarded';

export const IDEA_STATES: readonly IdeaState[] = ['parked', 'discussing', 'researching', 'reviewed', 'graduated', 'discarded'];

/** Where a graduated idea went. */
export type IdeaGraduation =
  | { kind: 'project'; projectId: string; taskId?: string }
  | { kind: 'issues'; urls: string[] };

export interface Idea {
  id: string;
  title: string;
  /** The parked notes / original one-liner the idea was captured with. */
  seed: string;
  state: IdeaState;
  /** Free-form tag strings. */
  tags: string[];
  /** "owner/repo" the idea would graduate into; null when undecided. */
  target_repo: string | null;
  /** The assistant session holding the idea's dialogue; null until first discussed. */
  session_id: string | null;
  graduated_to: IdeaGraduation | null;
  /** 'idea_watcher', or 'braindump' for rows migrated from the old table. */
  source: string;
  created_at: string;
  updated_at: string;
}

export interface CreateIdeaInput {
  title: string;
  seed?: string;
}

export interface UpdateIdeaInput {
  title?: string;
  seed?: string;
  state?: IdeaState;
  tags?: string[];
  target_repo?: string | null;
  graduated_to?: IdeaGraduation | null;
}

/** One issue of a graduation set, as reviewed and confirmed by the user. */
export interface IdeaIssueDraft {
  title: string;
  body: string;
  labels?: string[];
}

/** A chat thread — one conversation per row, linked to a project. */
export interface ChatThread {
  id: string;
  project_id: string;
  title: string;
  /** Current branch of the project checkout when the thread list was loaded. Empty when unavailable. */
  git_branch?: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SignalFilterFlags {
  ansi: boolean;
  progress: boolean;
  repeated_lines: boolean;
  package_manager: boolean;
  test_output: boolean;
  stack_trace: boolean;
  diff_context: boolean;
}

export interface SignalFilterProjectOverride {
  enabled?: boolean;
  min_input_bytes?: number;
  max_output_bytes?: number;
  filters?: Partial<SignalFilterFlags>;
}

export interface SignalFilterConfig {
  enabled: boolean;
  min_input_bytes: number;
  max_output_bytes: number;
  filters: SignalFilterFlags;
  projects: Record<string, SignalFilterProjectOverride>;
}

/** What the tool policy does with a call: run it, park it for a human, or refuse. */
export type ToolDecision = 'allow' | 'confirm' | 'deny';

/** Coarse tool grouping used to write policy without naming every tool.
 *  `unknown` (anything unclassified) is treated as side-effectful. */
export type ToolCategory =
  | 'interactive' | 'read' | 'write' | 'exec' | 'services' | 'network' | 'unknown';

/**
 * An input-aware rule: a decision for a tool, optionally narrowed to a named
 * built-in condition over the call's input (e.g. `remote_host` for a browser
 * navigation to a non-loopback URL). `when` omitted ⇒ the rule always applies
 * to that tool. Conditions are code-defined and bounded — config selects a
 * decision for a named condition, it does not author predicates. A rule naming
 * an unknown condition is ignored (fail-closed), never applied blindly.
 */
export interface ToolPolicyRule {
  tool: string;
  when?: string;
  decision: ToolDecision;
}

/** Category defaults and input-aware rules, as set globally or per project. */
export interface ToolPolicyOverride {
  categories?: Partial<Record<ToolCategory, ToolDecision>>;
  rules?: ToolPolicyRule[];
}

/** The `tool_policy` config block: global defaults plus per-project overrides
 *  keyed by repo path (same convention as `signal_filters.projects`). */
export interface ToolPolicyConfig extends ToolPolicyOverride {
  projects?: Record<string, ToolPolicyOverride>;
}

/** The external API helpers a user can enable (#291). Curated set: each has a
 *  hand-written request/verify/normalise path (src/backend/helpers/) rather than
 *  a generic "any REST API" form, so results reach the model clean and typed. */
export type HelperProvider = 'brave' | 'exa' | 'perplexity' | 'context7';

/** One helper provider's config. `api_key` supports ${ENV} interpolation and is
 *  masked by the settings routes; an empty/unresolvable key makes the provider
 *  unusable even when `enabled`, so its backing tool is omitted from the
 *  session (the same "never advertise a tool that can't run" rule Monday uses). */
export interface HelperConfig {
  enabled: boolean;
  api_key: string;
}

export type AgentBridgeMode = 'notify_only' | 'queue_for_approval';

/** Backend-owned real-time bridge for messages from other agent harnesses.
 * The transport is deliberately global to the Nexus process; individual Pi
 * sessions never connect to NATS or wake themselves. */
export interface AgentBridgeConfig {
  /** Off by default because enabling this opens a new inbound trust boundary. */
  enabled: boolean;
  /** Notify-only never starts work. Queue mode requires a human decision. */
  mode: AgentBridgeMode;
  /** NATS endpoint. Remote endpoints must use TLS and authentication. */
  url: string;
  /** Stable address included in every thread-directed envelope. */
  instance_id: string;
  /** Exact sender ids. `*` is an explicit allow-all choice. */
  allowed_senders: string[];
  /** Supports ${NEXUS_AGENT_BRIDGE_TOKEN}; masked by the Settings API. */
  token: string;
  max_message_bytes: number;
  max_messages_per_minute: number;
  max_hops: number;
}

export interface NexusConfig {
  server: {
    /** Local port the backend binds (loopback). */
    port: number;
    /** Remote backend base URL for thin-client mode (e.g. the Tailscale host,
     *  including any TLS port — `/api` is appended by the frontend). Empty or a
     *  loopback URL ⇒ full-stack: the desktop shell spawns a local backend.
     *  A remote (non-loopback) URL ⇒ the shell probes it, spawns nothing, and
     *  points the frontend's window.__NEXUS_API__ here. Mirrors memory.daemon_url. */
    url?: string;
    /** Bearer token gating the backend's /api/* (except /api/health). Supports
     *  ${ENV} interpolation; empty ⇒ dev-open (no auth). Mirrors gateway.token. */
    token?: string;
  };
  /** LAN gateway that serves the Even Realities G2 glasses cockpit
   *  (session-cockpit) the Nexus session feed + control API. */
  gateway: {
    /** When false the glasses gateway listener is not started. */
    enabled: boolean;
    /** LAN port the glasses connect to. Matches session-cockpit's default (8899). */
    port: number;
    /** Bearer token the glasses must present. Empty ⇒ dev-open (no auth). */
    token: string;
    /** Window (minutes) within which an idle session still counts as "recent"
     *  and is listed so it can be opened/steered from the glasses. */
    recent_minutes: number;
    /** Absolute path to the built glasses UI (session-cockpit/glasses/dist).
     *  When set, the gateway serves that SPA at `/` so the whole cockpit —
     *  UI + API — is one Nexus origin. Empty ⇒ API only. Env override:
     *  NEXUS_GLASSES_DIST. */
    glasses_dist: string;
    /** Speech-to-text for glasses voice steer/answer. Delivered to the glasses
     *  via GET /api/cockpit-config so the key lives here, not in the client.
     *  api_key supports ${ENV} interpolation; empty ⇒ voice disabled. */
    stt: {
      provider: string; // 'deepgram' | 'whisper-api' | 'soniox'
      api_key: string;
      language: string;
    };
  };
  models: {
    openrouter: { api_key: string };
    // Local OpenAI-compatible server. base_url should include the /v1 suffix,
    // e.g. http://localhost:8000/v1 for omlx. embedding_model / rerank_model
    // are optional; empty means that capability is disabled (memory falls back
    // to lexical TF-IDF search).
    local: {
      base_url: string;
      api_key: string;
      display_name: string;
      chat_model: string;
      supports_images: boolean;
      embedding_model: string;
      rerank_model: string;
    };
  };
  assistant: {
    /** OpenAI-compatible remote assistant endpoint, e.g. Hermes/OpenClaw. */
    url: string;
    /** Supports ${ASSISTANT_API_KEY}; raw values are masked by settings routes. */
    api_key: string;
  };
  signal_filters: SignalFilterConfig;
  memory: {
    // The standalone @nexus/memory-daemon (markdown-canonical vault + index).
    daemon_url: string;
    /** Session-archiving controls. See
     *  project_docs/design/2026-08-10-session-archiving-design.md. */
    archive: {
      /** Filtered transcripts up to this many chars summarise in one pass. Above
       *  it, the transcript is rolled up in ordered windows so the session's
       *  ending is never silently dropped. */
      max_single_pass_chars: number;
      /** Hard cap on roll-up windows. Beyond it, head+tail windows are used and
       *  the summary is marked `elided` rather than dropping content silently. */
      max_chunks: number;
      /** Length budget (model max_tokens) for the stored structured summary. */
      summary_target_tokens: number;
      /** Days a tombstoned raw session (.jsonl) is kept in .trash before the
       *  sweep purges it. 0 = hard-delete immediately on archive (old behaviour). */
      undo_retention_days: number;
    };
  };
  obsidian: {
    vault_path: string;
    sync_interval_seconds: number;
  };
  jira: {
    /** When false (default) the poll loop stays dormant. */
    enabled: boolean;
    /** Atlassian account email used for basic auth (paired with JIRA_TOKEN). */
    user: string;
    /** Jira Cloud host, e.g. "safety-services.atlassian.net". */
    instance: string;
    /** Project key to sync, e.g. "SUP". */
    project: string;
    /** Poll cadence in minutes while Nexus is running. */
    poll_minutes: number;
    /** User-maintained chunks stripped from every ticket body during cleaning.
     *  Whitespace/case-tolerant literal match; three asterisks match any text. */
    content_rules: string[];
  };
  github: {
    /** When false the GitHub issue sync no-ops. Defaults to true so existing
     *  behaviour is preserved. The token is read from GITHUB_TOKEN only. */
    enabled: boolean;
  };
  agent_bridge: AgentBridgeConfig;
  browser: {
    /** When false the browser tools are not registered at all. Off by default:
     *  a browser is a general-purpose fetch-and-execute engine, and the tools
     *  are omitted anyway when the machine has no Chromium-family browser. */
    enabled: boolean;
    /** Hosts the browser may reach beyond loopback, which is always allowed.
     *  `.example.com` matches subdomains; `example.com` matches exactly. Empty
     *  ⇒ this machine only, which is all "look at my dev server" needs. */
    allow_hosts: string[];
  };
  docker: {
    /** When false the `docker_service` tool is not registered at all — no
     *  session advertises it. Off by default: starting containers binds host
     *  ports and can mount host paths, so it is opt-in even where Docker runs.
     *  Enabling it does not make it silent; the tool policy defaults the
     *  `services` category to `confirm`. */
    enabled: boolean;
    /** Host path prefixes a compose file may bind-mount even though they're
     *  outside the project directory (e.g. a Docker socket). Empty/absent ⇒ a
     *  compose file that mounts any host path outside the repo is refused. */
    allow_host_mounts?: string[];
  };
  /** Optional per-tool approval policy (see src/backend/pi/tool-policy.ts).
   *  Absent ⇒ built-in defaults (read-only allowed, `services` confirmed).
   *  Category overrides and input-aware rules, global and per project. */
  tool_policy?: ToolPolicyConfig;
  monday: {
    /** When false the poll loop stays dormant and no tools are registered. */
    enabled: boolean;
    /** Pinned Monday API version. Monday dates its API; an unpinned client
     *  shifts under you. */
    api_version: string;
    /** Linked-item refresh cadence in minutes while Nexus is running. */
    poll_minutes: number;
  };
  /** User-enabled external API helpers (#291). Each provider is off by default
   *  and reaches the network with a paid key, so nothing is registered until the
   *  user opts in. When a provider is enabled with a resolvable key, its
   *  capability tool is registered for every session: web_search (Brave/Exa),
   *  web_answer (Perplexity), docs_lookup (Context7). Keys resolve server-side
   *  and never enter the prompt, transcript, or agent shell. */
  helpers: {
    brave: HelperConfig;
    exa: HelperConfig;
    perplexity: HelperConfig;
    context7: HelperConfig;
    /** Which provider `web_search` prefers when both Brave and Exa are enabled.
     *  Ignored when only one (or neither) search provider is on. */
    search_default: 'brave' | 'exa';
  };
  /** Apple Push Notification service for the iOS thin client. Off by default.
   *  The iOS app registers device tokens via POST /api/devices; Nexus then
   *  pushes on a pending tool-gate approval and on run completion. The `.p8`
   *  auth-key material follows the secret pattern — env-referenced or a file
   *  path, masked by the settings route, resolved server-side at send time. */
  apns: {
    enabled: boolean;
    /** APNs Auth Key ID (10 chars) from the Apple Developer portal. */
    key_id: string;
    /** Apple Developer Team ID (10 chars). */
    team_id: string;
    /** App bundle id, used as the APNs topic (e.g. it.resolve.nexus). */
    bundle_id: string;
    /** 'sandbox' (development builds) or 'production' (TestFlight/App Store).
     *  Selects the APNs host; per-device `env` can override at send time. */
    environment: 'sandbox' | 'production';
    /** Path to the `.p8` auth-key file (leading ~ expanded). Preferred, since
     *  the key is multi-line PEM. */
    key_path: string;
    /** Inline `.p8` key material; supports ${ENV} interpolation. Used only when
     *  key_path is empty. Masked by the settings route; never returned raw. */
    key: string;
  };
}

/** Which roll-up bucket each Kanban column contributes to. */
export const MONDAY_ROLLUP_BUCKETS: Record<TaskStatus, 'open' | 'inProgress' | 'inReview' | 'done'> = {
  triage: 'open',
  todo: 'open',
  in_progress: 'inProgress',
  review: 'inReview',
  deploy: 'done',
};

/** Recommended Kanban-column → Monday status-label mapping, used purely to
 *  prefill the status-sync config UI the first time it is enabled. Only labels
 *  whose text actually exists on the chosen board are applied; the stored
 *  config is whatever the user saves. Deliberately maps nothing to the
 *  human-owned inbox label ("Wants attention"). */
export const MONDAY_STATUS_SYNC_DEFAULT_MAPPING: Partial<Record<TaskStatus, string>> = {
  triage: 'Planned',
  todo: 'Planned',
  in_progress: 'In flight',
  review: 'Near done',
  deploy: 'Complete',
};

/** A mirrored Monday item. Disposable — Monday stays canonical. */
export interface MondayItem {
  item_id: string;
  board_id: string;
  board_name: string;
  group_id: string | null;
  group_title: string | null;
  name: string;
  /** 'missing' is Nexus-local: the item vanished from Monday but a link survives. */
  state: 'active' | 'archived' | 'deleted' | 'missing';
  status_label: string | null;
  status_color: string | null;
  /** JSON array of owner display names. */
  owners_json: string;
  url: string | null;
  /** Raw column values, keyed by column id. Context injection and the read
   *  tools need fields this schema does not model. */
  column_values_json: string;
  /** JSON array of the item's most recent updates — entries from Monday's
   *  per-item comment thread, fetched via the `updates` connection in
   *  client.ts's ITEM_FIELDS. Emphatically NOT a column value, despite the
   *  neighbouring `column_values_json`. Each entry is
   *  `{ text: string; created_at: string | null }`, in whatever order Monday
   *  sent; session-deps.ts's recentUpdates() orders it newest-first on read.
   *  Optional so fixtures and rows written before this field existed need not
   *  supply it — the column itself is NOT NULL DEFAULT '[]'. */
  updates_json?: string;
  monday_updated_at: string | null;
  synced_at: string;
}

/** A mirrored item enriched with its Nexus roll-up, as returned by the API. */
export interface MondayItemWithLinks extends MondayItem {
  rollup: { total: number; open: number; inProgress: number; inReview: number; done: number };
  rollup_text: string;
  task_ids: string[];
}

/** A task→item link. NOT disposable: user intent, survives a mirror wipe. */
export interface TaskMondayLink {
  task_id: string;
  item_id: string;
  project_id: string;
  created_at: string;
}

/** Per-project Monday scope and opt-ins, stored in projects.config_json. */
export interface MondayProjectConfig {
  board_id: string;
  /** Optional narrowing to a single group on the board. */
  group_id?: string | null;
  rollup: {
    enabled: boolean;
    column_id: string | null;
    /** Resolved when the column is chosen, not inferred per write: Monday
     *  column ids are user-renamable, so the id is not a reliable type hint. */
    column_type: 'text' | 'numeric';
  };
  updates: { enabled: boolean; min_interval_minutes: number };
  /** Push the Nexus task lifecycle onto the item's Monday status column.
   *  Opt-in and off by default — it is the third Nexus→Monday write path
   *  (alongside `rollup` and `updates`), and the only one that writes a
   *  column a human also owns, so it carries extra guardrails (see
   *  backend/monday/status-sync.ts). Optional so a legacy or hand-written
   *  `monday` block with no `status_sync` sub-key at all stays valid input —
   *  the write path guards it with the same optional chaining `rollup`/
   *  `updates` already rely on. */
  status_sync?: {
    enabled: boolean;
    /** The status column to write. Chosen from the board's status columns in
     *  the config UI; required whenever `enabled` is true. */
    column_id: string | null;
    /** When true (the default), Nexus only ever advances an item to a later
     *  lifecycle stage — a card dragged backwards never regresses a status a
     *  human may be relying on. */
    forward_only: boolean;
    /** Kanban column → Monday status **label text**. A column with no entry
     *  (or an empty string) means "don't drive the status from this column".
     *  Text, not the label index: it is what the mirror already stores, so
     *  the no-op/forward-only/hold comparisons need no extra fetch. Nothing
     *  here should map to the human-owned inbox label ("Wants attention"). */
    mapping: Partial<Record<TaskStatus, string>>;
  };
}

export interface ProjectConfig {
  column_defaults: Record<TaskStatus, string | null>;
  monday?: MondayProjectConfig;
}

export const KANBAN_COLUMNS: TaskStatus[] = ['triage', 'todo', 'in_progress', 'review', 'deploy'];

export const KANBAN_COLUMN_LABELS: Record<TaskStatus, string> = {
  triage: 'Triage',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  deploy: 'Deploy',
};

/** Kinds of long-running operation the activity bus tracks.
 *
 *  Lives in shared because both ends validate against it — the backend's
 *  /api/activity kind filter and the frontend's Activity Console labels — and
 *  they used to keep separate copies. Both copies then missed the Monday and
 *  mission kinds, so a monday_sync operation was unfilterable server-side and
 *  rendered with a blank label client-side. One list, no drift.
 *
 *  `as const` rather than a bare union: the values are needed at runtime for
 *  validation, and the type is derived from them rather than restated. */
export const OPERATION_KINDS = [
  'chat_turn',
  'assistant_stream',
  'jira_sync',
  'github_sync',
  'monday_sync',
  'monday_write',
  'memory_archive',
  'memory_index',
  // Missions were removed (#353); the kind stays so legacy `operations` rows
  // in existing DBs remain renderable and filterable.
  'mission_tick',
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export * from './agent-run.js';
export * from './approval-decision.js';
