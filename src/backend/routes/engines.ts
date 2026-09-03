import type { FastifyInstance } from 'fastify';
import type { ClaudeEngineConfig } from '../engines/claude/auth.js';
import { claudeEngineStatus, isPiAnthropicOAuthHidden } from '../engines/claude/status.js';
import { loadConfig } from '../config.js';

export interface RegisterEngineRoutesOptions {
  config?: () => ClaudeEngineConfig;
  env?: NodeJS.ProcessEnv;
}

export async function registerEngineRoutes(fastify: FastifyInstance, options: RegisterEngineRoutesOptions = {}) {
  const config = options.config ?? (() => loadConfig().engines.claude);
  const env = options.env ?? process.env;
  fastify.get('/api/engines', async () => {
    const cfg = config();
    return {
      engines: [claudeEngineStatus(cfg, env)],
      piAnthropicOAuthHidden: isPiAnthropicOAuthHidden(cfg, fastify.pi.paths.authFile),
    };
  });
}
