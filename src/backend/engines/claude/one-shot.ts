/**
 * One prompt in, one text out, through the Claude Agent SDK — the same
 * harness the chat engine uses, with everything session-shaped switched off:
 * no tools, one turn, nothing persisted, no project checkout as cwd. Used by
 * the ticket draft (#432); anything else that needs a stateless model call
 * through the subscription login belongs here too.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeAuthEnv, type ClaudeEngineConfig } from './auth.js';

export interface OneShotRequest {
  /** Bare model id (`claude-sonnet-5`), not the `claude-code/` key. */
  modelId: string;
  systemPrompt: string;
  prompt: string;
  /** Kills the call when the model wanders; drafting is a few seconds. */
  timeoutMs?: number;
}

export type OneShotQueryFn = typeof sdkQuery;

export async function runClaudeOneShot(
  cfg: ClaudeEngineConfig,
  req: OneShotRequest,
  queryFn: OneShotQueryFn = sdkQuery,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 60_000);
  const options: Options = {
    cwd: join(homedir(), '.nexus'),
    model: req.modelId,
    tools: [],
    maxTurns: 1,
    persistSession: false,
    settingSources: [],
    systemPrompt: req.systemPrompt,
    permissionMode: 'default',
    abortController: controller,
    env: resolveClaudeAuthEnv(cfg),
    ...(cfg.executable_path?.trim() ? { pathToClaudeCodeExecutable: cfg.executable_path.trim() } : {}),
  };
  try {
    let text = '';
    for await (const message of queryFn({ prompt: req.prompt, options })) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success') {
        text = message.result ?? '';
      } else {
        const errors = (message as { errors?: string[] }).errors;
        throw new Error(errors?.length ? errors.join('; ') : `Claude one-shot failed: ${message.subtype}`);
      }
    }
    return text;
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Claude one-shot timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
