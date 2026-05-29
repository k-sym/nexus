/**
 * Agent providers.
 *
 * One function per provider, all returning a ProviderResult. CLI providers
 * (Claude Code, Codex) are spawned as child processes with a 5-minute timeout
 * and their stdout/stderr streamed to a callback. API providers (OpenRouter,
 * Ollama) are called over HTTP, with Ollama consuming a streaming response.
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

export function runClaudeCode(workspace: string, prompt: string, onOutput: StreamCallback): Promise<ProviderResult> {
  return new Promise(resolve => {
    const startTime = Date.now();
    const fullOutput: string[] = [];

    const child = spawn('claude', ['--no-interactive', '-p', prompt], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      fullOutput.push(text);
      onOutput(text);
    });

    child.stderr.on('data', (data: Buffer) => {
      fullOutput.push(data.toString());
    });

    child.on('close', (code: number | null) => {
      const output = fullOutput.join('');
      resolve({
        ok: code === 0,
        output,
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    });

    child.on('error', (err: Error) => {
      const output = fullOutput.join('');
      resolve({
        ok: false,
        output,
        error: err.message,
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    });

    setTimeout(() => {
      child.kill('SIGTERM');
      const output = fullOutput.join('');
      resolve({
        ok: false,
        output,
        error: 'Timed out after 5 minutes',
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    }, TIMEOUT_MS);
  });
}

export function runCodex(workspace: string, prompt: string, onOutput: StreamCallback): Promise<ProviderResult> {
  return new Promise(resolve => {
    const startTime = Date.now();
    const fullOutput: string[] = [];

    const child = spawn('codex', [prompt], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      fullOutput.push(text);
      onOutput(text);
    });

    child.stderr.on('data', (data: Buffer) => {
      fullOutput.push(data.toString());
    });

    child.on('close', (code: number | null) => {
      const output = fullOutput.join('');
      resolve({
        ok: code === 0,
        output,
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    });

    child.on('error', (err: Error) => {
      const output = fullOutput.join('');
      resolve({
        ok: false,
        output,
        error: err.message,
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    });

    setTimeout(() => {
      child.kill('SIGTERM');
      const output = fullOutput.join('');
      resolve({
        ok: false,
        output,
        error: 'Timed out after 5 minutes',
        durationMs: Date.now() - startTime,
        usage: estimateUsage(prompt, output),
      });
    }, TIMEOUT_MS);
  });
}

export async function runOpenRouter(
  persona: PersonaConfig,
  prompt: string,
  apiKey: string,
  onOutput: StreamCallback
): Promise<ProviderResult> {
  const startTime = Date.now();

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://nexus.local',
        'X-Title': 'NEXUS Agent',
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
      throw new Error(`OpenRouter API error ${response.status}: ${body}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    onOutput(content);

    // Prefer real usage from the API; fall back to estimate.
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

export async function runOllama(
  persona: PersonaConfig,
  prompt: string,
  baseUrl: string,
  onOutput: StreamCallback
): Promise<ProviderResult> {
  const startTime = Date.now();
  const fullOutput: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: persona.model,
        messages: [
          { role: 'system', content: persona.system_prompt },
          { role: 'user', content: prompt },
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          const content = chunk.message?.content || '';
          if (content) {
            fullOutput.push(content);
            onOutput(content);
          }
          // Ollama reports token counts on the final chunk.
          if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
          if (chunk.eval_count) completionTokens = chunk.eval_count;
          if (chunk.done) break;
        } catch { /* skip malformed */ }
      }
    }

    const output = fullOutput.join('');
    const usage: TokenUsage = (promptTokens || completionTokens)
      ? { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens }
      : estimateUsage(`${persona.system_prompt}\n${prompt}`, output);

    return {
      ok: true,
      output,
      durationMs: Date.now() - startTime,
      usage,
    };
  } catch (err: any) {
    return {
      ok: false,
      output: fullOutput.join(''),
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
