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
import { NexusConfig, PersonaConfig } from '@nexus/shared';
import { resolveEnvVars, resolveOpenRouterKey } from '../config';

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
}

type StreamCallback = (chunk: string) => void;

/** Rough token estimate (~1.3 tokens per whitespace-delimited word). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
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
): Promise<ProviderResult> {
  return new Promise(resolve => {
    const startTime = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;

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
      // Only stdout is the answer; stderr is diagnostics surfaced on failure.
      const output = stripAnsi(stdoutChunks.join('')).trim();
      const error = ok ? undefined : errOverride || stripAnsi(stderrChunks.join('')).trim() || 'unknown error';
      resolve({ ok, output, error, durationMs: Date.now() - startTime, usage: estimateUsage(prompt, output) });
    };

    child.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      stdoutChunks.push(text);
      onOutput(text);
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

    child.on('close', (code: number | null) => finish(code === 0, code === 0 ? undefined : `Exited with code ${code}`));
    child.on('error', (err: Error) => finish(false, err.message));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false, 'Timed out after 5 minutes');
    }, TIMEOUT_MS);
  });
}

export function runClaudeCode(
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  config?: CliConfig,
  model?: string,
): Promise<ProviderResult> {
  const command = config?.command || 'claude';
  const args = [...(config?.args ?? []), ...(model ? ['--model', model] : []), '-p', prompt];
  return runCli(command, args, workspace, prompt, onOutput);
}

export function runCodex(
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  config?: CliConfig,
  model?: string,
): Promise<ProviderResult> {
  const command = config?.command || 'codex';
  const args = [...(config?.args ?? []), ...(model && model !== 'codex-default' ? ['--model', model] : []), prompt];
  return runCli(command, args, workspace, prompt, onOutput);
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
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API error ${response.status}: ${body}`);
    }

    const data = await response.json() as any;
    if (data.error) throw new Error(data.error.message || String(data.error));

    const content = data.choices?.[0]?.message?.content || '';
    onOutput(content);

    // Prefer real usage from the API; fall back to an estimate if absent.
    const usage: TokenUsage = data.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
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
): Promise<ProviderResult> {
  const withSystem = persona.system_prompt ? `${persona.system_prompt}\n\n${prompt}` : prompt;

  switch (persona.provider) {
    case 'claude_code': {
      // Full tools, scoped to the persona's declared toolset (--allowedTools),
      // rather than a blanket permission bypass.
      const allowed = mapToolsToClaude(persona.tools);
      const args = [
        ...(config.claude_code.args ?? []),
        ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
      ];
      return runClaudeCode(workspace, withSystem, onOutput, { command: config.claude_code.command, args }, claudeModelAlias(persona.model));
    }
    case 'codex':
      return runCodex(workspace, withSystem, onOutput, { command: config.codex.command, args: config.codex.args }, persona.model);
    case 'openrouter':
      return runOpenAICompatible(
        persona,
        prompt,
        { baseUrl: OPENROUTER_BASE, apiKey: resolveOpenRouterKey(config), headers: { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS' } },
        onOutput,
      );
    case 'local':
    case 'ollama':
      return runOpenAICompatible(persona, prompt, { baseUrl: config.models.local.base_url, apiKey: config.models.local.api_key }, onOutput);
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
