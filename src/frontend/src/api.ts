/**
 * Frontend API client.
 *
 * The chat thread, persona, provider, and OAuth surfaces are gone.
 * Each thread is now a pi-runtime-backed session; auth lives in
 * ~/.nexus/auth.json; the model registry is the curated pi list.
 */
import { Project, Task, ChatThread, Ticket, TicketDescription, GitDiffState, ReviewActionRequest, ReviewActionResult, Idea, IdeaState, CreateIdeaInput, UpdateIdeaInput, IdeaIssueDraft, MondayItem, MondayItemWithLinks, TaskMondayLink, MondayProjectConfig } from '@nexus/shared';
export type { GitDiffState, ReviewActionRequest, ReviewActionResult } from '@nexus/shared';
import { apiFetch } from './api-base';
import type { QuestionAnswer } from './lib/questions';

export type AgentHealth = 'online' | 'ready' | 'offline';

export interface MissionStatus {
  memory: {
    ok: boolean;
    status?: string;
    memories?: number;
    jobs?: { pending: number; dead: number };
    models?: { gen: boolean; embed: boolean; rerank: boolean };
    error?: string;
  };
  models: Array<{ provider: string; id: string; name: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; configured: boolean }>;
  modelCounts?: { active: number; available: number };
  stats?: Record<'claude' | 'codex' | 'openrouter', {
    ok: boolean;
    value: string;
    caption: string;
    windows?: Partial<Record<'session' | 'weekly', { usedPercent: number; remainingPercent: number; resetLabel?: string; resetsAt?: string; windowMinutes?: number }>>;
    source?: string;
    sampledAt?: string;
    error?: string;
  }>;
}

export interface NotificationItem {
  id: string;
  level: 'info' | 'error';
  title: string;
  message: string;
  created_at: string;
}

export interface ModelsResponse {
  models: any[];
  allModels: any[];
  enabledModelKeys: string[];
  customized: boolean;
}

export interface LocalModelTestRequest {
  base_url: string;
  api_key: string;
  chat_model: string;
}

export interface LocalModelTestResponse {
  ok: boolean;
  message: string;
  models: string[];
  modelFound?: boolean;
}

export interface HelperTestResponse {
  ok: boolean;
  message: string;
}

// Re-exported, not restated: this list and the backend's used to be separate
// copies, and both went stale when the Monday kinds landed.
import type { OperationKind, OperationStatus } from '@nexus/shared';
export { OPERATION_KINDS, OPERATION_STATUSES } from '@nexus/shared';
export type { OperationKind, OperationStatus } from '@nexus/shared';

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  title: string;
  project_id: string | null;
  task_id: string | null;
  thread_id: string | null;
  provider: string | null;
  model: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  usage?: unknown;
  last_event: string | null;
  error: string | null;
  diagnostics?: unknown;
}

export interface ActivityResponse {
  running: Operation[];
  recent: Operation[];
  counts: Record<string, number>;
}

export interface ActiveChatRunsResponse {
  activeThreadIds: string[];
  runs: Array<{
    threadId: string;
    title: string;
    modelKey: string;
    projectId: string | null;
    waitingForResponse: boolean;
    questionCount: number;
  }>;
}

/** One live (non-archived) session, from any project. */
export interface ChatSessionSummary {
  threadId: string;
  projectId: string;
  title: string;
  updatedAt: string;
}

export interface ChatSessionsResponse {
  sessions: ChatSessionSummary[];
}

export type SecretSource = 'environment' | 'config-env-reference' | 'config-literal' | 'pi-auth-file' | 'gh-cli' | 'absent' | 'unknown';

export interface TrustSecret {
  configured: boolean;
  source: SecretSource;
  location?: string;
  credentialType?: 'api_key' | 'oauth';
}

export interface TrustSnapshot {
  services: Array<{ name: string; url: string; loopback: boolean }>;
  storage: Array<{ name: string; path: string; role: 'canonical' | 'rebuildable' | 'application' | 'credentials' | 'configuration' }>;
  secrets: Record<string, TrustSecret>;
  memory: {
    namespaces: string[];
    recall: { mode: 'on_demand'; tool: string; maxMemories: number; tokenBudget: number };
    archive: { mode: 'manual'; destination: string; removesHotThreadAfterSuccess: true };
  };
  outbound: Array<{ name: string; destination: string; sends: string[]; enabled: boolean }>;
  telemetry: { applicationTelemetry: false; statement: string };
}

export interface ReindexResult {
  scanned: number;
  inserted: number;
  updated: number;
  noop: number;
  removed: number;
  reindexed: number;
  queued: number;
}

export type FilePreview =
  | { path: string; name: string; mimeType: string; kind: 'text'; size: number; content: string }
  | { path: string; name: string; mimeType: string; kind: 'image'; size: number; data: string }
  | { path: string; name: string; mimeType: string; kind: 'pdf'; size: number; url: string }
  | { path: string; name: string; mimeType: string; kind: 'unsupported'; size: number; reason?: string };

export interface ClearNexusResult {
  namespace: 'nexus';
  deleted: number;
  failed: number;
  paths: string[];
  failures: Array<{ path: string; error: string }>;
  ok?: boolean;
  reconciliation?: ReindexResult | null;
  reconciliationError?: string;
}

export interface MemoryRecord {
  id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** An Error thrown by `fetchJson` for a non-ok response. `code`/`retryable` are
 *  attached only when the backend's error body carried them (e.g. Monday's
 *  502 `{ error, code, retryable }`) — callers that don't care can keep
 *  treating this as a plain `Error`. */
export interface FetchJsonError extends Error {
  code?: string;
  retryable?: boolean;
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects no-body DELETE/POST requests with 400 ("body cannot be empty").
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  const res = await apiFetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: FetchJsonError = new Error((body as any).error || res.statusText);
    if (typeof (body as any).code === 'string') err.code = (body as any).code;
    if (typeof (body as any).retryable === 'boolean') err.retryable = (body as any).retryable;
    throw err;
  }
  return res.json() as Promise<T>;
}

// Tool decisions — the audit trail read path (#281 part 2).
export interface ToolDecisionEntry {
  id: number;
  thread_id: string;
  cwd: string;
  tool_name: string;
  category: string;
  input_summary: string;
  decision: 'allow' | 'confirm' | 'deny';
  source: string;
  rule_tool: string | null;
  rule_when: string | null;
  outcome: 'allowed' | 'denied';
  answered_by: string;
  created_at: string;
}

export async function fetchToolDecisions(limit = 100): Promise<ToolDecisionEntry[]> {
  const data = await fetchJson<{ decisions: ToolDecisionEntry[] }>(`/api/approvals/audit?limit=${limit}`);
  return data.decisions;
}

// Agent browser — the human-facing preview of a thread's headless page (#283).
export interface BrowserView {
  image: { data: string; mimeType: string };
  url: string;
  title: string;
  viewport: { width: number; height: number };
  colorScheme: 'dark' | 'light';
  version: number;
  capturedAt: number;
}
export interface BrowserViewResponse {
  /** The feature is on and a browser binary exists. */
  available: boolean;
  /** This thread has a browser open with a frame to show. */
  present: boolean;
  /** The client's `known` version is current — no new bytes are sent. */
  unchanged?: boolean;
  version?: number;
  view?: BrowserView;
}

/** The thread's current browser preview. `known` is the last version the client
 *  holds, so an unchanged static page comes back without re-sending the frame. */
export async function fetchBrowserView(threadId: string, known?: number): Promise<BrowserViewResponse> {
  const params = new URLSearchParams({ thread: threadId });
  if (known !== undefined) params.set('known', String(known));
  return fetchJson<BrowserViewResponse>(`/api/browser/view?${params.toString()}`);
}

// Monday.com — the Project Management view's read paths and link CRUD.
// Free-standing exports (not nested under `api`) so ProjectManagementView can
// import and mock them directly, matching the Task 11 brief's client surface.
export async function fetchMondayItems(projectId: string, refresh = false): Promise<MondayItemWithLinks[]> {
  const query = refresh ? '?refresh=1' : '';
  const data = await fetchJson<{ items: MondayItemWithLinks[] }>(`/api/monday/projects/${projectId}/items${query}`);
  return data.items;
}

export async function searchMondayItems(projectId: string, query: string): Promise<MondayItem[]> {
  const data = await fetchJson<{ items: MondayItem[] }>(
    `/api/monday/projects/${projectId}/search?q=${encodeURIComponent(query)}`,
  );
  return data.items;
}

export async function fetchMondayLinks(projectId: string): Promise<TaskMondayLink[]> {
  const data = await fetchJson<{ links: TaskMondayLink[] }>(`/api/monday/projects/${projectId}/links`);
  return data.links;
}

export async function linkTaskToMondayItem(projectId: string, taskId: string, itemId: string): Promise<void> {
  await fetchJson(`/api/monday/links`, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, task_id: taskId, item_id: itemId }),
  });
}

export async function unlinkTaskFromMondayItem(taskId: string): Promise<void> {
  await fetchJson(`/api/monday/links/${taskId}`, { method: 'DELETE' });
}

// Task 15 — per-project Monday scope configuration. Free-standing exports
// for the same reason as the block above: MondayScopeSettings imports and
// mocks these directly.
export interface MondayBoardSummary {
  id: string;
  name: string;
  workspace: string | null;
}

/** One selectable label on a Monday status column (mirror of the backend's
 *  MondayStatusLabel — this crosses as JSON, so the shape is restated here). */
export interface MondayStatusLabel {
  index: number;
  text: string;
  color: string | null;
}

export interface MondayBoardMetaResult {
  groups: Array<{ id: string; title: string }>;
  /** Status columns carry their selectable `labels`; other column types omit it. */
  columns: Array<{ id: string; title: string; type: string; labels?: MondayStatusLabel[] }>;
}

export async function fetchMondayBoards(): Promise<MondayBoardSummary[]> {
  const data = await fetchJson<{ boards: MondayBoardSummary[] }>(`/api/monday/boards`);
  return data.boards;
}

export async function fetchMondayBoardMeta(boardId: string): Promise<MondayBoardMetaResult> {
  return fetchJson<MondayBoardMetaResult>(`/api/monday/boards/${encodeURIComponent(boardId)}/meta`);
}

export async function fetchMondayProjectConfig(projectId: string): Promise<MondayProjectConfig | null> {
  const data = await fetchJson<{ config: MondayProjectConfig | null }>(`/api/monday/projects/${projectId}/config`);
  return data.config;
}

export async function saveMondayProjectConfig(projectId: string, config: MondayProjectConfig): Promise<MondayProjectConfig> {
  const data = await fetchJson<{ config: MondayProjectConfig }>(`/api/monday/projects/${projectId}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
  return data.config;
}

// Partner routine fleet — proxied from the assistant adapter's /v1/routines
// (baker-internal#82). Snake_case mirrors the adapter wire shape.
export type RoutineHealth = 'ok' | 'failed' | 'stale' | 'pending';

export interface RoutineLastRun {
  started: number | null;
  ended: number | null;
  rc: number | null;
  timed_out: boolean;
  source: 'status' | 'stamp';
}

export interface Routine {
  name: string;
  label: string;
  schedule: Array<Record<string, number>>;
  schedule_display: string;
  last_run: RoutineLastRun | null;
  health: RoutineHealth;
  last_expected: number | null;
  next_due: number | null;
}

export interface RoutineDetail extends Routine {
  log_tail: string[];
}

export interface RoutinesResponse {
  configured?: boolean;
  routines: Routine[];
  generated_at?: number;
  error?: string;
}

// Night-queue board — proxied from the assistant adapter's /v1/night-queue
// (baker-internal#111). What the overnight runner (#55) did, what is queued
// for tonight, and which of its PRs are still open. Snake_case mirrors the
// adapter wire shape, as with the routine fleet above.

/** What the RUNNER observed, never the coder model's claim about its own
 * homework. `null` means the ledger row predates the column — unknown, which
 * is not the same as `not_run`. Anything but `passed` makes a PR a draft. */
export type NightTests = 'passed' | 'failed' | 'not_run' | null;

export type NightRunStatus = 'pr_opened' | 'parked' | 'no_changes' | 'timeout' | 'failed' | null;

export type NightVerdict = 'approve' | 'arbitrated_ship' | 'arbitrated_park' | 'unreviewed' | null;

/** `quiet` = nothing was labelled, the normal night. Not a failure. */
export type NightOutcome = 'worked' | 'quiet' | 'running';

export interface NightRun {
  id: string;
  repo: string;
  issue_number: number;
  branch: string | null;
  started_at: string | null;
  started_ts: number | null;
  ended_at: string | null;
  ended_ts: number | null;
  status: NightRunStatus;
  rounds: number;
  verdict: NightVerdict;
  pr_url: string | null;
  tokens_used: number;
  error: string | null;
  summary: string;
  tests: NightTests;
  issue_url: string | null;
}

export interface Night {
  id: string;
  started_at: string | null;
  started_ts: number | null;
  ended_at: string | null;
  ended_ts: number | null;
  stop_reason: string | null;
  issues_planned: number;
  issues_attempted: number;
  tokens_used: number;
  outcome: NightOutcome;
  /** Rollups the adapter computes so web and iOS cannot disagree. */
  prs_opened: number;
  unvalidated: number;
  failures: number;
  runs: NightRun[];
}

export interface NightPlan {
  selected: Array<{ repo?: string; number?: number; title?: string; model?: string; budget_tokens?: number; rationale?: string }>;
  parked: Array<{ repo?: string; number?: number; reason?: string }>;
  excluded: Array<{ repo?: string; number?: number; title?: string }>;
}

export interface NightDetail extends Night {
  plan: NightPlan;
}

export interface QueuedIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  updated_at: string | null;
  updated_ts: number | null;
  /** baker-internal and nexus: labelled, but the runner never touches them. */
  excluded: boolean;
  readiness: string | null;
  readiness_source: 'comment' | 'body' | null;
}

export interface NightQueuePR {
  repo: string;
  number: number;
  title: string;
  url: string;
  created_at: string | null;
  created_ts: number | null;
  is_draft: boolean;
}

/** What the scheduled launchd job last did, from the wrapper's status file.
 * The ledger cannot answer this: a night that dies before the runner opens it
 * writes no row, so this is the only evidence such an attempt happened. */
export interface NightAttempt {
  started: number | null;
  ended: number | null;
  rc: number | null;
  timed_out: boolean | null;
  source: 'status' | 'stamp' | null;
  /** rc === 0. A legacy stamp has no exit code and reports false: unknown is
   * not success. */
  ok: boolean;
  /** Whether a ledger night covers this attempt. Independent of `ok` — a run
   * that exited 0 and wrote no night is still unaccounted for. `null` when
   * there is no ledger to check. */
  recorded: boolean | null;
}

export interface NightQueueResponse {
  configured?: boolean;
  /** False until the runner has written its first night. */
  available: boolean;
  nights: Night[];
  last_attempt?: NightAttempt | null;
  queue: QueuedIssue[];
  queue_error?: string | null;
  queue_stale?: boolean;
  open_prs: NightQueuePR[];
  open_prs_error?: string | null;
  open_prs_stale?: boolean;
  generated_at?: number;
  /** Set when the backend could not reach the adapter at all. */
  error?: string;
}

// Readiness workshop — the night queue's front door (baker-internal#111).
// Reads are cheap; `assess` costs a model call and `arm` is the only write.

export type BlockedReason = 'excluded' | 'queued' | 'open_pr' | null;

export interface NightQueueBlocker {
  number: number;
  url: string;
  branch: string;
  /** How the PR was linked: an explicit "Fixes #N", our own nq/ branch, or a
   * branch named after the issue. */
  reason: 'linked' | 'nq_branch' | 'branch_name';
}

export interface NightQueueCandidate {
  repo: string;
  number: number;
  title: string;
  url: string;
  updated_at: string | null;
  updated_ts: number | null;
  labels: string[];
  queued: boolean;
  excluded: boolean;
  open_pr: NightQueueBlocker | null;
  /** null = nothing structurally blocks arming. NOT "ready" — nothing here has
   * been judged against the bar yet. */
  blocked: BlockedReason;
}

export interface NightQueueCandidatesResponse {
  configured?: boolean;
  candidates: NightQueueCandidate[];
  /** Count with no structural blocker. Deliberately not called "armable". */
  unblocked?: number;
  generated_at?: number;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

export interface ReadinessCriterion {
  id: string;
  label: string;
  requirement: string;
  /** Set when the criterion only applies to some issues (reachability). */
  conditional: string | null;
}

export interface ReadinessResponse {
  configured?: boolean;
  criteria: ReadinessCriterion[];
  /** The verbatim bar the 01:00 planner enforces. */
  bar_text?: string;
  comment_template?: string;
  excluded_repos?: string[];
  error?: string;
}

export interface AssessedCriterion {
  id: string;
  label: string;
  status: 'met' | 'missing' | 'na';
  note: string;
}

export interface AssessmentResponse {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  queued: boolean;
  excluded: boolean;
  open_pr: NightQueueBlocker | null;
  /** Recomputed from the criteria, never taken from the model. */
  ready: boolean;
  /** False when the verdict was decided without a model call (excluded repo). */
  assessed: boolean;
  summary: string;
  criteria: AssessedCriterion[];
  /** Gaps arrive as `<TODO: …>` and must be resolved before arming. */
  draft_comment: string;
}

export interface DiscussResponse {
  session_id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  session_title: string;
  error?: string;
}

export interface ArmResponse {
  repo: string;
  number: number;
  title: string;
  url: string;
  queued: boolean;
  label: string;
  comment_posted: boolean;
  decision: { class: string; recorded: boolean; promotable: boolean; streak?: number; error?: string };
}

// Outbound draft queue — proxied from the assistant adapter's /v1/drafts
// (baker-internal#42). Replies the partner proposed; approving one SENDS it.
export type DraftStatus = 'pending' | 'approved' | 'sent' | 'rejected' | 'expired' | 'failed';

export interface OutboundDraft {
  id: string;
  /** 'mail' (default) or 'meeting' (baker-internal#43). Approving a meeting BOOKS it. */
  kind?: 'mail' | 'meeting';
  account: string;
  status: DraftStatus;
  subject: string;
  to: string[];
  cc: string[];
  reply_to: string | null;
  thread: string | null;
  source: string;
  rationale: string;
  created_iso?: string;
  /** True once the body has been rewritten by hand (#97) — the approval that
   *  follows records as approved_with_edits in the autonomy ledger. */
  edited?: boolean;
  /** Meeting-kind fields (#43): ISO local times, invitees, Teams flag. */
  start?: string;
  end?: string;
  attendees?: string[];
  online?: boolean;
  preview: string;
  body_chars: number;
}

/** Detail carries the FULL body: approving something you have only seen a
 *  preview of is not consent. */
export interface OutboundDraftDetail extends OutboundDraft {
  body: string;
  sendable: boolean;
  sendable_reason: string;
  status_detail?: Record<string, string>;
}

export interface DraftsResponse {
  configured?: boolean;
  drafts: OutboundDraft[];
  pending: number;
  error?: string;
}

export interface DraftDecision extends OutboundDraft {
  sent?: boolean;
  booked?: boolean;
}

// Idea Watcher (#352) — one created GitHub issue of a graduation set.
export interface CreatedIssue {
  number: number;
  html_url: string;
}

export interface GraduateIssuesResult {
  issues: CreatedIssue[];
  idea: Idea;
}

/** Thrown when issue filing fails part-way: `issues` are the ones that DID
 *  land on GitHub (the backend records them on the idea either way). */
export interface GraduateIssuesError extends Error {
  issues?: CreatedIssue[];
}

export const api = {
  projects: {
    list: () => fetchJson<Project[]>(`/api/projects`),
    get: (id: string) => fetchJson<Project>(`/api/projects/${id}`),
    create: (data: { name: string; badge?: string; repo_path: string }) =>
      fetchJson<Project>(`/api/projects`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Project, 'name' | 'badge' | 'repo_path' | 'config_json'>>) =>
      fetchJson<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    reorder: (projectIds: string[]) =>
      fetchJson<Project[]>(`/api/projects/order`, { method: 'PUT', body: JSON.stringify({ project_ids: projectIds }) }),
    delete: (id: string) => fetchJson<void>(`/api/projects/${id}`, { method: 'DELETE' }),
    tasks: (id: string) => fetchJson<Task[]>(`/api/projects/${id}/tasks`),
    createTask: (id: string, data: { title: string; description?: string; status?: string; priority?: string; assigned_agent?: string }) =>
      fetchJson<Task>(`/api/projects/${id}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
    githubSync: (id: string) =>
      fetchJson<{ created: number; total: number }>(`/api/projects/${id}/github/sync`, { method: 'POST' }),
    gitDiff: (id: string) => fetchJson<GitDiffState>(`/api/projects/${id}/git/diff`),
    previewFile: (id: string, path: string) =>
      fetchJson<FilePreview>(`/api/projects/${id}/files/preview?path=${encodeURIComponent(path)}`),
    reviewAction: (id: string, data: ReviewActionRequest) =>
      fetchJson<ReviewActionResult>(`/api/projects/${id}/review-actions`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  tasks: {
    update: (id: string, data: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assigned_agent' | 'due_date' | 'model_key' | 'thread_id'>>) =>
      fetchJson<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  },
  chat: {
    threads: (projectId: string) => fetchJson<ChatThread[]>(`/api/projects/${projectId}/threads`),
    activeRuns: () => fetchJson<ActiveChatRunsResponse>(`/api/chat/active-runs`),
    // Every live session across all projects, running or not.
    sessions: () => fetchJson<ChatSessionsResponse>(`/api/chat/sessions`),
    // Creates a thread. Threads don't bind to a persona any more.
    // The optional `title` sets the initial title (defaults to "New Session").
    createThread: (projectId: string, title?: string) =>
      fetchJson<ChatThread>(`/api/projects/${projectId}/threads`, {
        method: 'POST',
        body: JSON.stringify(title ? { title } : {}),
      }),
    renameThread: (threadId: string, title: string) =>
      fetchJson<ChatThread>(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    archiveThread: (threadId: string) => fetchJson<{ memoryId: string | null; elided?: boolean }>(`/api/threads/${threadId}/archive`, { method: 'POST' }),
    deleteThread: (threadId: string) => fetchJson<void>(`/api/threads/${threadId}`, { method: 'DELETE' }),
    answerQuestion: (threadId: string, toolCallId: string, answers: QuestionAnswer[]) =>
      fetchJson<{ ok: true }>(
        `/api/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(toolCallId)}/answer`,
        { method: 'POST', body: JSON.stringify({ answers }) },
      ),
    setSupervised: (threadId: string, supervised: boolean) =>
      fetchJson<{ threadId: string; supervised: boolean }>(
        `/api/threads/${encodeURIComponent(threadId)}/supervise`,
        { method: 'POST', body: JSON.stringify({ supervised }) },
      ),
  },
  models: {
    list: () => fetchJson<ModelsResponse>(`/api/models`),
    saveCuration: (enabledModelKeys: string[]) =>
      fetchJson<ModelsResponse>(`/api/models/curation`, {
        method: 'PUT',
        body: JSON.stringify({ enabledModelKeys }),
      }),
    setActive: (provider: string, model: string) =>
      fetchJson<{ ok: boolean }>(`/api/models/active`, {
        method: 'POST',
        body: JSON.stringify({ provider, model }),
      }),
  },
  settings: {
    get: () => fetchJson<any>(`/api/settings`),
    update: (config: any) => fetchJson<any>(`/api/settings`, { method: 'PUT', body: JSON.stringify(config) }),
    testLocalModel: (data: LocalModelTestRequest) =>
      fetchJson<LocalModelTestResponse>(`/api/settings/local-model/test`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    testHelper: (provider: string, api_key?: string) =>
      fetchJson<HelperTestResponse>(`/api/settings/helpers/${encodeURIComponent(provider)}/test`, {
        method: 'POST',
        body: JSON.stringify({ api_key }),
      }),
  },
  trust: {
    get: () => fetchJson<TrustSnapshot>('/api/trust'),
    rebuildMemory: () => fetchJson<ReindexResult>('/api/trust/memory/rebuild', { method: 'POST' }),
    clearNexusMemory: (confirmation: string) => fetchJson<ClearNexusResult>('/api/trust/memory/clear-nexus', {
      method: 'POST',
      body: JSON.stringify({ confirmation }),
    }),
  },
  missionControl: {
    get: () => fetchJson<MissionStatus>(`/api/mission-control`),
  },
  drafts: {
    list: (status = 'pending') => fetchJson<DraftsResponse>(`/api/drafts?status=${encodeURIComponent(status)}`),
    get: (id: string) => fetchJson<OutboundDraftDetail>(`/api/drafts/${encodeURIComponent(id)}`),
    edit: (id: string, body: string, by = 'web') =>
      fetchJson<OutboundDraftDetail>(`/api/drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, by }),
      }),
    approve: (id: string, by = 'web') =>
      fetchJson<DraftDecision>(`/api/drafts/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by }),
      }),
    reject: (id: string, note?: string, by = 'web') =>
      fetchJson<DraftDecision>(`/api/drafts/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by, ...(note ? { note } : {}) }),
      }),
  },
  routines: {
    list: () => fetchJson<RoutinesResponse>(`/api/routines`),
    get: (name: string) => fetchJson<RoutineDetail>(`/api/routines/${encodeURIComponent(name)}`),
  },
  nightQueue: {
    list: (nights?: number) =>
      fetchJson<NightQueueResponse>(`/api/night-queue${nights ? `?nights=${nights}` : ''}`),
    night: (id: string) => fetchJson<NightDetail>(`/api/night-queue/nights/${encodeURIComponent(id)}`),
    readiness: () => fetchJson<ReadinessResponse>(`/api/night-queue/readiness`),
    candidates: () => fetchJson<NightQueueCandidatesResponse>(`/api/night-queue/candidates`),
    assess: (repo: string, number: number) =>
      fetchJson<AssessmentResponse>(`/api/night-queue/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, number }),
      }),
    /** Opens a Partner conversation about one issue, seeded server-side with
     * the readiness bar and the fenced issue text. The working draft goes with
     * it so the Partner argues about the text on screen, not the assessor's
     * first attempt. Returns a session id the ordinary assistant endpoints
     * then drive. */
    discuss: (repo: string, number: number, draft: string) =>
      fetchJson<DiscussResponse>(`/api/night-queue/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, number, draft }),
      }),
    /** The only write: posts the readiness comment, then mints the label. */
    arm: (repo: string, number: number, comment: string) =>
      fetchJson<ArmResponse>(`/api/night-queue/arm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, number, comment }),
      }),
  },
  tickets: {
    list: () => fetchJson<Ticket[]>(`/api/tickets`),
    description: (key: string, refresh = false) =>
      fetchJson<TicketDescription>(`/api/tickets/${encodeURIComponent(key)}/description${refresh ? '?refresh=1' : ''}`),
  },
  ideas: {
    /** Non-terminal ideas by default; `all` includes graduated/discarded. */
    list: (all = false) => fetchJson<Idea[]>(`/api/ideas${all ? '?all=1' : ''}`),
    listByState: (state: IdeaState) => fetchJson<Idea[]>(`/api/ideas?state=${encodeURIComponent(state)}`),
    create: (data: CreateIdeaInput) =>
      fetchJson<Idea>(`/api/ideas`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: UpdateIdeaInput) =>
      fetchJson<Idea>(`/api/ideas/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) => fetchJson<{ success: true }>(`/api/ideas/${id}`, { method: 'DELETE' }),
    /** Idempotent: creates the idea's assistant session lazily (parked → discussing). */
    ensureSession: (id: string) =>
      fetchJson<{ sessionId: string }>(`/api/ideas/${id}/session`, { method: 'POST' }),
    /**
     * Graduate into a project: records graduation AND moves the idea's upload
     * folder (project_docs/uploads/ideas/<id>/) into the project repo. A 400
     * mentioning "repo path" means files exist but the project's repo path is
     * unusable — surface it verbatim; the idea is NOT graduated in that case.
     */
    graduateProject: (id: string, projectId: string) =>
      fetchJson<{ idea: Idea; movedFiles: number }>(`/api/ideas/${id}/graduate/project`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    /**
     * CONFIRM-GATED GitHub write: only call after the user explicitly
     * confirmed the reviewed drafts in the UI. On partial failure the thrown
     * error carries the already-created `issues` (GraduateIssuesError).
     */
    graduateIssues: async (id: string, data: { repo: string; issues: IdeaIssueDraft[] }): Promise<GraduateIssuesResult> => {
      const res = await apiFetch(`/api/ideas/${id}/graduate/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err: GraduateIssuesError = new Error((body as any).error || res.statusText);
        if (Array.isArray((body as any).issues)) err.issues = (body as any).issues;
        throw err;
      }
      return body as GraduateIssuesResult;
    },
  },
  assistant: {
    thread: () => fetchJson<{ id: 'global'; messages: any[] }>(`/api/assistant/thread`),
    /** Adopt a session the ADAPTER created (e.g. a night-queue workshop
     * conversation) into a nexus session, so the ordinary per-session chat
     * endpoints can drive it. Adoption is a local pointer at the remote
     * session — history still renders live from the adapter. */
    importRemote: (remoteSessionId: string) =>
      fetchJson<{ session: { id: string } }>(`/api/assistant/sessions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteSessionId }),
      }),
    sessions: () =>
      fetchJson<{ sessions: Array<{ id: string; status?: string; latestRun?: { status?: string } | null }> }>(
        `/api/assistant/sessions`,
      ),
  },
  notifications: {
    list: () => fetchJson<NotificationItem[]>(`/api/notifications`),
    seen: (ids: string[]) =>
      fetchJson<{ ok: boolean }>(`/api/notifications/seen`, { method: 'POST', body: JSON.stringify({ ids }) }),
  },
  memory: {
    search: (projectId: string, query: string) => fetchJson<MemoryRecord[]>(`/api/projects/${projectId}/memories?q=${encodeURIComponent(query)}`),
    list: (projectId: string) => fetchJson<MemoryRecord[]>(`/api/projects/${projectId}/memories`),
    create: (projectId: string, data: { content: string; category?: string; agent_id?: string }) =>
      fetchJson<any>(`/api/projects/${projectId}/memories`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { content: string }) =>
      fetchJson<void>(`/api/memories/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`/api/memories/${id}`, { method: 'DELETE' }),
  },
  activity: {
    list: (params?: { status?: string; kind?: string; limit?: number }) =>
      fetchJson<ActivityResponse>(`/api/activity${qs(params ?? {})}`),
    get: (id: string) => fetchJson<Operation>(`/api/activity/${id}`),
    abort: (id: string) => fetchJson<{ ok: boolean }>(`/api/activity/${id}/abort`, { method: 'POST' }),
    retry: (id: string) => fetchJson<{ ok: boolean }>(`/api/activity/${id}/retry`, { method: 'POST' }),
    diagnostics: (id: string) =>
      fetchJson<{ diagnostics?: unknown; lastEvent?: string; error?: string }>(`/api/activity/${id}/diagnostics`),
  },
};
