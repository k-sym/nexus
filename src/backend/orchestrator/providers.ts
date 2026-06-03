/**
 * Agent providers.
 *
 * Each provider returns a ProviderResult. CLI providers (Claude Code, Codex)
 * are spawned as child processes with a 5-minute timeout, streaming their
 * stdout/stderr to a callback. HTTP providers (OpenRouter and any local
 * OpenAI-compatible server such as omlx) share a single client that differs
 * only by base URL and auth.
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NexusConfig, PersonaConfig, Provider } from '@nexus/shared';
import { resolveEnvVars, resolveOpenRouterKey } from '../config';
import { ASK_CONVENTION } from '../chat/ask';

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ProviderResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  usage: TokenUsage;
  /** Resumable CLI session id, when the provider exposes one (Claude Code). */
  sessionId?: string;
}

type StreamCallback = (chunk: string) => void;

/** Rough token estimate (~1.3 tokens per whitespace-delimited word). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

/** Split a free-form CLI args string into argv. v1: whitespace split (no quote handling). */
export function splitArgs(s: string | null | undefined): string[] {
  return (s ?? '').trim().split(/\s+/).filter(Boolean);
}

/** Derive Hermes' /health URL from its OpenAI-compatible base (…/v1 → …/health). */
export function hermesHealthUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/health';
}

/** Build argv for `opencode run`: model flag (if any), then extra args, then the prompt. */
export function buildOpenCodeArgs(
  model: string | null | undefined,
  args: string | null | undefined,
  prompt: string,
): string[] {
  return ['run', ...(model ? ['--model', model] : []), ...splitArgs(args), prompt];
}

const TIMEOUT_MS = 300_000;

export interface CliConfig {
  command: string;
  args: string[];
}

/**
 * Spawn a CLI agent as a child process, streaming output and enforcing a
 * 5-minute timeout. Shared by the Claude Code and Codex providers; the only
 * difference between them is the command and how the prompt is passed.
 */
/** Strip ANSI/terminal escape sequences a CLI might emit when not on a TTY. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function runCli(
  command: string,
  args: string[],
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  // When set, kill the process only after this long with NO output (an *idle*
  // timeout — long-but-active tasks keep running). When unset, fall back to the
  // wall-clock TIMEOUT_MS cap. Callers that stream (Claude Code's stream-json)
  // pass an idle timeout; one-shot callers keep the wall-clock cap.
  idleTimeoutMs?: number,
): Promise<ProviderResult> {
  return new Promise(resolve => {
    const startTime = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;
    let timer: NodeJS.Timeout;

    // stdin: 'ignore' so the CLI sees EOF immediately (the prompt is passed via
    // args, not stdin) — otherwise it waits ~3s and warns about missing stdin.
    const child = spawn(command, args, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (ok: boolean, errOverride?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Only stdout is the answer; on failure include stderr (or stdout as a
      // fallback) alongside the exit code so the real reason isn't swallowed.
      const output = stripAnsi(stdoutChunks.join('')).trim();
      const stderr = stripAnsi(stderrChunks.join('')).trim();
      const error = ok ? undefined : [errOverride, stderr || output].filter(Boolean).join(' — ') || 'unknown error';
      resolve({ ok, output, error, durationMs: Date.now() - startTime, usage: estimateUsage(prompt, output) });
    };

    // Arm/re-arm the watchdog. Idle mode re-arms on every chunk (below); wall-clock
    // mode arms once and is never reset.
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(false, idleTimeoutMs
          ? `No activity for ${Math.round(idleTimeoutMs / 1000)}s — killed (possible hang)`
          : 'Timed out after 5 minutes');
      }, idleTimeoutMs ?? TIMEOUT_MS);
    };

    child.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      stdoutChunks.push(text);
      onOutput(text);
      if (idleTimeoutMs) armTimer();
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString());
      if (idleTimeoutMs) armTimer();
    });

    child.on('close', (code: number | null) => finish(code === 0, code === 0 ? undefined : `Exited with code ${code}`));
    child.on('error', (err: Error) => finish(false, err.message));

    armTimer();
  });
}

export interface ClaudeSession {
  /** The session UUID to use. For a NEW session it's one we generate and pass via
   *  `--session-id` (so we know/store it before the turn runs); for an existing
   *  thread it's the stored id, resumed via `--resume`. */
  id: string;
  /** true → `--resume <id>` (continue), false → `--session-id <id>` (create). */
  isResume: boolean;
}

export async function runClaudeCode(
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  config?: CliConfig,
  model?: string,
  session?: ClaudeSession,
  idleTimeoutMs?: number,
): Promise<ProviderResult> {
  const command = config?.command || 'claude';
  // `--output-format stream-json --verbose` streams the turn as newline-delimited
  // JSON events. We use it for three things: (1) a liveness signal so the watchdog
  // can be an *idle* timeout instead of a wall-clock cap, (2) the session id is in
  // every event (incl. the first), and (3) the terminal `result` event carries the
  // final text + is_error. `--session-id` creates a session with an id we already
  // know (so it can be stored/surfaced before the turn finishes); `--resume`
  // continues an existing one so a thread is one continuous conversation.
  const sessionArgs = session
    ? (session.isResume ? ['--resume', session.id] : ['--session-id', session.id])
    : [];
  const args = [
    ...(config?.args ?? []),
    ...sessionArgs,
    ...(model ? ['--model', model] : []),
    '--output-format', 'stream-json', '--verbose',
    '-p', prompt,
  ];
  const result = await runCli(command, args, workspace, prompt, onOutput, idleTimeoutMs);

  // Parse the NDJSON event stream: capture the session id and the terminal result.
  let text: string | undefined;
  let isError = false;
  let sessionId = session?.id;
  let sawResult = false;
  for (const line of result.output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed) as { type?: string; session_id?: string; result?: string; is_error?: boolean };
      if (typeof ev.session_id === 'string') sessionId = ev.session_id;
      if (ev.type === 'result') {
        sawResult = true;
        if (typeof ev.result === 'string') text = ev.result;
        isError = ev.is_error === true;
      }
    } catch {
      // Skip non-JSON noise (the stream is normally pure NDJSON).
    }
  }

  if (sawResult) {
    return {
      ...result,
      ok: result.ok && !isError,
      output: text ?? '',
      sessionId,
      error: isError ? (text || result.error || 'Claude Code reported an error') : result.error,
    };
  }
  // No terminal result (e.g. killed by the idle watchdog mid-turn): keep runCli's
  // ok/error, but still surface the session id so the turn can be resumed.
  return { ...result, sessionId };
}

export async function runCodex(
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  config?: CliConfig,
  model?: string,
): Promise<ProviderResult> {
  const command = config?.command || 'codex';
  // Codex must run via `exec` to be non-interactive — a bare `codex "<prompt>"`
  // forwards to the interactive TUI, which fails when spawned without a TTY.
  // `--output-last-message` writes just the final reply (stdout is a verbose
  // transcript). `workspace-write` gives it scoped tools within the project dir.
  const outFile = path.join(os.tmpdir(), `nexus-codex-${process.pid}-${Date.now()}.txt`);
  const args = [
    'exec',
    // `--json` streams JSONL events (parsed for the live preview); the authoritative
    // final reply still comes from `--output-last-message`.
    '--json',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    ...(config?.args ?? []),
    ...(model && model !== 'codex-default' ? ['--model', model] : []),
    '--output-last-message', outFile,
    prompt,
  ];

  const result = await runCli(command, args, workspace, prompt, onOutput);

  // Prefer the clean final message file; with --json, stdout is JSONL (not the
  // reply), so fall back to the last agent_message in the stream, not raw stdout.
  let last = '';
  try {
    last = fs.readFileSync(outFile, 'utf8').trim();
    fs.unlinkSync(outFile);
  } catch { /* file missing (early failure) */ }
  if (!last) last = assembleCliFinal('codex', result.output);
  if (last) return { ...result, output: last };
  const errMsg = extractCliError(result.output);
  if (errMsg) return { ...result, ok: false, output: '', error: `Codex: ${errMsg}` };
  return result;
}

/**
 * Assemble the final reply text from a CLI's raw NDJSON stream, as a fallback when
 * the clean output isn't otherwise available. Uses the stream adapters' delta
 * extraction; for OpenCode, dedups re-emitted parts by id (latest wins).
 */
function assembleCliFinal(kind: 'codex' | 'opencode', raw: string): string {
  if (kind === 'opencode') {
    const parts = new Map<string, string>();
    const order: string[] = [];
    for (const line of raw.split('\n')) {
      let ev: any; try { ev = JSON.parse(line.trim()); } catch { continue; }
      if (ev?.type === 'text' && ev.part?.text) {
        const id = ev.part.id ?? String(order.length);
        if (!parts.has(id)) order.push(id);
        parts.set(id, ev.part.text);
      }
    }
    return order.map(id => parts.get(id) ?? '').join('');
  }
  // codex: concatenate agent_message item texts (usually a single final message).
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    let ev: any; try { ev = JSON.parse(line.trim()); } catch { continue; }
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) out.push(ev.item.text);
  }
  return out.join('');
}

/**
 * Pull a clean human-readable message out of a CLI's `type:error` JSON events
 * (OpenCode/Codex), so chat shows e.g. "Model not found: …" instead of a raw
 * JSON blob + exit code. Returns the first error message found, if any.
 */
function extractCliError(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    let ev: any; try { ev = JSON.parse(line.trim()); } catch { continue; }
    if (ev?.type === 'error') {
      const msg = ev.error?.data?.message ?? ev.error?.message ?? ev.message;
      if (msg) return String(msg);
    }
  }
  return undefined;
}

export async function runOpenCode(
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  model?: string,
  extraArgs?: string | null,
): Promise<ProviderResult> {
  // A bare `opencode` opens the interactive TUI; `run` is required for headless one-shot.
  // OpenCode uses its OWN provider credentials (e.g. OpenRouter) — Nexus just invokes the CLI.
  // `--format json` streams JSON events (parsed for the live preview); the final
  // reply is assembled from the text parts since stdout is no longer plain text.
  const args = buildOpenCodeArgs(model, extraArgs, prompt);
  args.splice(1, 0, '--format', 'json'); // after 'run', before model/args/prompt
  const result = await runCli('opencode', args, workspace, prompt, onOutput);
  const final = assembleCliFinal('opencode', result.output);
  if (final) return { ...result, output: final };
  // No assistant text — surface a clean error if OpenCode emitted one (e.g. the
  // model was momentarily unavailable) instead of the raw JSON-error stdout.
  const errMsg = extractCliError(result.output);
  if (errMsg) return { ...result, ok: false, output: '', error: `OpenCode: ${errMsg}` };
  return result;
}

export interface OpenAICompatibleOptions {
  /** Base URL including the /v1 suffix, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string;
  /** Bearer token; omit/empty for local servers that need no auth. */
  apiKey?: string;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). */
  headers?: Record<string, string>;
}

/**
 * Call any OpenAI-compatible chat completions endpoint. Used for both
 * OpenRouter (cloud) and local servers (omlx, LM Studio, llama.cpp, …) — the
 * only differences are the base URL, auth, and a few optional headers.
 */
export async function runOpenAICompatible(
  persona: PersonaConfig,
  prompt: string,
  opts: OpenAICompatibleOptions,
  onOutput: StreamCallback,
): Promise<ProviderResult> {
  const startTime = Date.now();

  try {
    if (!opts.baseUrl) throw new Error('No base_url configured for this provider');

    const response = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify({
        model: persona.model,
        messages: [
          { role: 'system', content: persona.system_prompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: persona.token_budget,
        stream: true,
        // Ask for usage in the terminal SSE chunk; servers that don't support it
        // just omit it and we fall back to an estimate.
        stream_options: { include_usage: true },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API error ${response.status}: ${body}`);
    }
    if (!response.body) throw new Error('No response body from streaming endpoint');

    // Parse the OpenAI SSE stream: `data: {json}` lines, terminated by `data: [DONE]`.
    // Each delta's content is forwarded to onOutput for the live preview; we also
    // accumulate the full text and capture usage from the final chunk if present.
    let content = '';
    let usageRaw: any = null;
    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.error) throw new Error(json.error.message || String(json.error));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { content += delta; onOutput(delta); }
        if (json.usage) usageRaw = json.usage;
      }
    }

    // Prefer real usage from the API; fall back to an estimate if absent.
    const usage: TokenUsage = usageRaw
      ? {
          prompt: usageRaw.prompt_tokens ?? 0,
          completion: usageRaw.completion_tokens ?? 0,
          total: usageRaw.total_tokens ?? 0,
        }
      : estimateUsage(`${persona.system_prompt}\n${prompt}`, content);

    return {
      ok: true,
      output: content,
      durationMs: Date.now() - startTime,
      usage,
    };
  } catch (err: any) {
    return {
      ok: false,
      output: '',
      error: err.message,
      durationMs: Date.now() - startTime,
      usage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}

/** Estimate prompt/completion/total tokens from input + output text. */
function estimateUsage(promptText: string, outputText: string): TokenUsage {
  const prompt = estimateTokens(promptText);
  const completion = estimateTokens(outputText);
  return { prompt, completion, total: prompt + completion };
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Map a persona's abstract tool names to Claude Code CLI tool names. */
function mapToolsToClaude(tools: string[]): string[] {
  const map: Record<string, string[]> = {
    read_file: ['Read'],
    write_file: ['Write', 'Edit'],
    run_command: ['Bash'],
    list_files: ['Glob', 'Grep'],
  };
  const out = new Set<string>();
  for (const t of tools ?? []) (map[t] ?? []).forEach(x => out.add(x));
  return [...out];
}

/** Normalize a configured model to a CLI alias the `claude` binary accepts. */
function claudeModelAlias(model: string): string | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return model;
}

/**
 * Dispatch a prompt to whichever provider a persona is configured for, returning
 * a uniform ProviderResult. CLI providers (Claude Code / Codex) get the persona's
 * system prompt prepended (one-shot prompt); HTTP providers receive it as a system
 * message. Shared by chat (agent control rooms) so the thread's agent actually
 * drives the reply. The `prompt` should be the conversation body WITHOUT the
 * system prompt (this adds it where needed).
 */
export function runPersona(
  persona: PersonaConfig,
  prompt: string,
  workspace: string,
  config: NexusConfig,
  onOutput: StreamCallback,
  provider?: Provider,
  claudeSession?: ClaudeSession,
  idleTimeoutMs?: number,
): Promise<ProviderResult> {
  const sys = persona.system_prompt
    ? `${persona.system_prompt}\n\n${ASK_CONVENTION}`
    : ASK_CONVENTION;
  const withSystem = `${sys}\n\n${prompt}`;
  const personaWithSys: PersonaConfig = { ...persona, system_prompt: sys };

  // When *resuming* a Claude Code session, the system prompt + conversation are
  // already in the session — send only the new turn (the caller passes just the
  // latest message), so we don't re-inject the persona prompt every turn. A new
  // session (`--session-id`) still gets the full system prompt.
  const claudePrompt = claudeSession?.isResume ? prompt : withSystem;

  // Provider-first: a persona that references a Provider record dispatches by the
  // provider's kind + endpoint. (Legacy `provider` enum below is the fallback.)
  if (provider) {
    const model = persona.model || provider.default_model || '';
    switch (provider.kind) {
      case 'claude_code': {
        const allowed = mapToolsToClaude(persona.tools);
        const args = [...(config.claude_code.args ?? []), ...(allowed.length ? ['--allowedTools', allowed.join(',')] : [])];
        return runClaudeCode(workspace, claudePrompt, onOutput, { command: config.claude_code.command, args }, claudeModelAlias(model), claudeSession, idleTimeoutMs);
      }
      case 'codex':
        return runCodex(workspace, withSystem, onOutput, { command: config.codex.command, args: config.codex.args }, model);
      case 'opencode':
        return runOpenCode(workspace, withSystem, onOutput, model, provider.args);
      case 'openai_compat':
      case 'hermes': {
        const baseUrl = resolveEnvVars(provider.base_url || '');
        const apiKey = resolveEnvVars(provider.api_key || '');
        const headers = /openrouter\.ai/.test(baseUrl) ? { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS' } : undefined;
        return runOpenAICompatible({ ...personaWithSys, model }, prompt, { baseUrl, apiKey, headers }, onOutput);
      }
    }
  }

  switch (persona.provider) {
    case 'claude_code': {
      // Full tools, scoped to the persona's declared toolset (--allowedTools),
      // rather than a blanket permission bypass.
      const allowed = mapToolsToClaude(persona.tools);
      const args = [
        ...(config.claude_code.args ?? []),
        ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
      ];
      return runClaudeCode(workspace, claudePrompt, onOutput, { command: config.claude_code.command, args }, claudeModelAlias(persona.model), claudeSession, idleTimeoutMs);
    }
    case 'codex':
      return runCodex(workspace, withSystem, onOutput, { command: config.codex.command, args: config.codex.args }, persona.model);
    case 'openrouter':
      return runOpenAICompatible(
        personaWithSys,
        prompt,
        { baseUrl: OPENROUTER_BASE, apiKey: resolveOpenRouterKey(config), headers: { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS' } },
        onOutput,
      );
    case 'local':
    case 'ollama':
      return runOpenAICompatible(personaWithSys, prompt, { baseUrl: config.models.local.base_url, apiKey: config.models.local.api_key }, onOutput);
    default:
      return Promise.resolve({
        ok: false,
        output: '',
        error: `Unknown provider: ${persona.provider}`,
        durationMs: 0,
        usage: { prompt: 0, completion: 0, total: 0 },
      });
  }
}
