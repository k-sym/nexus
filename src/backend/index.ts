/**
 * NEXUS backend entry point.
 *
 * Boots a single Fastify process that hosts the HTTP API and starts the
 * background Jira poller. Task work runs interactively in chat threads
 * (the old headless orchestrator dispatch loop has been removed).
 */
import Fastify from 'fastify';
import { join } from 'node:path';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { getDb } from './db.js';
import { loadConfig, getDbPath, getNexusDir, resolveOpenRouterKey } from './config.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerOrchestratorRoutes } from './routes/orchestrator.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerBraindumpRoutes } from './routes/braindump.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPiRoutes } from './routes/pi.js';
import { registerActivityRoutes } from './routes/activity.js';
import { initMemorySystem } from './memory/index.js';
import { startJiraSync } from './jira/poll.js';
import { ActivityManager } from './activity/manager.js';
import { PiRuntime } from './pi/runtime.js';
import { ConcurrencyTracker } from './pi/concurrency.js';
import { ModelCurationStore } from './pi/model-curation.js';
import { OAuthFlowManager } from './pi/oauth-flows.js';
import { backfillOAuthCuratedModels } from './pi/oauth-curation-backfill.js';
import { loadLocalEnvFile } from './env.js';

async function main() {
  loadLocalEnvFile();
  const config = loadConfig();

  const db = getDb(getDbPath());
  const pi = new PiRuntime();

  const openRouterKey = resolveOpenRouterKey(config);
  if (openRouterKey) {
    pi.auth.setRuntimeApiKey('openrouter', openRouterKey);
  }

  await initMemorySystem(db);
  const activityManager = new ActivityManager(db);
  const stopActivityListening = activityManager.startListening();
  startJiraSync(db, activityManager);

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(websocket);

  app.decorate('db', db);
  app.decorate('pi', pi);
  const modelCuration = new ModelCurationStore(join(getNexusDir(), 'model-curation.json'));
  backfillOAuthCuratedModels(pi, modelCuration);

  app.decorate('chatConcurrency', new ConcurrencyTracker());
  app.decorate('modelCuration', modelCuration);
  app.decorate('oauthFlows', new OAuthFlowManager(pi.auth));
  app.decorate('activity', activityManager);

  app.register(registerProjectRoutes);
  app.register(registerChatRoutes);
  app.register(registerAssistantRoutes);
  app.register(registerOrchestratorRoutes);
  app.register(registerMemoryRoutes);
  app.register(registerSettingsRoutes);
  app.register(registerStatusRoutes);
  app.register(registerTicketRoutes);
  app.register(registerBraindumpRoutes);
  app.register(registerNotificationRoutes);
  app.register(registerAuthRoutes);
  app.register(registerPiRoutes);
  app.register(registerActivityRoutes);

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const err = error as any;
    const statusCode = err.statusCode || 500;
    reply.status(statusCode).send({ error: err.message });
  });

  try {
    await app.listen({ port: config.server.port, host: '127.0.0.1' });
    console.log(`NEXUS backend running on http://127.0.0.1:${config.server.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
