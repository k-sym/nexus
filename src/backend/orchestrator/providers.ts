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
import { PersonaConfig } from '@nexus/shared';
import { resolveEnvVars } from '../config';

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
function runCli(
  command: string,
  args: string[],
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
): Promise<ProviderResult> {
  return new Promise(resolve => {
    const startTime = Date.now();
    const fullOutput: string[] = [];
    let settled = false;

    const child = spawn(command, args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (result: Omit<ProviderResult, 'durationMs' | 'usage'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = fullOutput.join('');
      resolve({
        ...result,
        output,
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    };

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      fullOutput.push(text);
      onOutput(text);
    });

    child.stderr.on('data', (data: Buffer) => {
      fullOutput.push(data.toString());
    });

    child.on('close', (code: number | null) => {
      finish({ ok: code === 0, output: '', error: code === 0 ? undefined : `Exited with code ${code}` });
    });

    child.on('error', (err: Error) => {
      finish({ ok: false, output: '', error: err.message });
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, output: '', error: 'Timed out after 5 minutes' });
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
