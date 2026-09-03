/**
 * Environment for the SDK's Claude Code child process.
 *
 * Subscription-first: the whole point of this engine is to use a Claude
 * Pro/Max login through Anthropic's own harness, so `ANTHROPIC_API_KEY` is
 * removed unless the user explicitly picks `auth: api_key` (a stray key in the
 * dev shell would otherwise silently bill the API). A `claude setup-token`
 * token is passed through when configured; with nothing configured the
 * bundled Claude Code uses this machine's existing login.
 */
import type { NexusConfig } from '@nexus/shared';

export type ClaudeEngineConfig = NexusConfig['engines']['claude'];

const CLIENT_APP = 'nexus/0.1.0';

export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => env[name] || '');
}

export function resolveClaudeAuthEnv(
  cfg: ClaudeEngineConfig,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP };
  const token = interpolate(cfg.oauth_token || '', base).trim();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  else delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (cfg.auth !== 'api_key') delete env.ANTHROPIC_API_KEY;
  return env;
}
