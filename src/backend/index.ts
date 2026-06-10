/**
 * NEXUS backend entry point.
 *
 * Boots a single Fastify process that hosts the HTTP API and starts three
 * background loops: the orchestrator (agent dispatch), the scheduler (cron),
 * and the Obsidian vault watcher.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { getDb } from './db';
import { loadConfig, getDbPath, resolveOpenRouterKey } from './config';
import { registerProjectRoutes } from './routes/projects';
import { registerChatRoutes } from './routes/chat';
import { registerOrchestratorRoutes } from './routes/orchestrator';
import { registerMemoryRoutes } from './routes/memory';
import { registerScheduleRoutes } from './routes/schedules';
import { registerSettingsRoutes } from './routes/settings';
import { registerStatusRoutes } from './routes/status';
import { registerTicketRoutes } from './routes/tickets';
import { registerNotificationRoutes } from './routes/notifications';
import { registerAuthRoutes } from './routes/auth';
import { registerPiRoutes } from './routes/pi';
import { startOrchestrator } from './orchestrator';
import { initMemorySystem } from './memory';
import { startScheduler } from './scheduler';
import { startJiraSync } from './jira/poll';
import { PiRuntime } from './pi/runtime';
import { ConcurrencyTracker } from './pi/concurrency';

async function main() {
  const config = loadConfig();

  const db = getDb(getDbPath());
  const pi = new PiRuntime();

  const openRouterKey = resolveOpenRouterKey(config);
  if (openRouterKey) {
    pi.auth.setRuntimeApiKey('openrouter', openRouterKey);
  }

  await initMemorySystem(db);
  startOrchestrator(db, pi);
  if (config.scheduler.enabled) {
    startScheduler(db);
  }
  startJiraSync(db);

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(websocket);

  app.decorate('db', db);
  app.decorate('pi', pi);
  app.decorate('chatConcurrency', new ConcurrencyTracker());

  app.register(registerProjectRoutes);
  app.register(registerChatRoutes);
  app.register(registerOrchestratorRoutes);
  app.register(registerMemoryRoutes);
  app.register(registerScheduleRoutes);
  app.register(registerSettingsRoutes);
  app.register(registerStatusRoutes);
  app.register(registerTicketRoutes);
  app.register(registerNotificationRoutes);
  app.register(registerAuthRoutes);
  app.register(registerPiRoutes);

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
