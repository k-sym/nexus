/**
 * NEXUS backend entry point.
 *
 * Boots a single Fastify process that hosts the HTTP API and starts the
 * background Jira poller. Task work runs interactively in chat threads
 * (the old headless orchestrator dispatch loop has been removed).
 */
import Fastify from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import { getDb } from './db.js';
import { loadConfig, getDbPath, getNexusDir, resolveOpenRouterKey, resolveEnvVars, expandHome } from './config.js';
import { startGateway } from './gateway/server.js';
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
import { registerApprovalRoutes } from './routes/approvals.js';
import { DockerAvailability, buildDockerToolDeps, buildTearDownServices } from './docker/session-deps.js';
import { sweepOrphanedProjects, describeSweep } from './docker/sweep.js';
import { createBrowserSupport } from './browser/session-deps.js';
import { registerDockerRoutes } from './routes/docker.js';
import { resolveToolPolicy, EMPTY_TOOL_POLICY } from './pi/tool-policy-config.js';
import { DbApprovalAudit } from './approvals/audit.js';
import { registerTrustRoutes } from './routes/trust.js';
import { registerMissionRoutes } from './routes/missions.js';
import { registerMondayRoutes } from './routes/monday.js';
import { registerNextMessageRoutes } from './routes/next-message.js';
import { initMemorySystem, recallForRepoPath } from './memory/index.js';
import { startJiraSync } from './jira/poll.js';
import { startMondayPoll } from './monday/poll.js';
import { buildMondayContext, buildMondayToolDeps } from './monday/session-deps.js';
import { startMissionScheduler } from './missions/runner.js';
import { ActivityManager } from './activity/manager.js';
import { PiRuntime, defaultPiRuntimePaths } from './pi/runtime.js';
import { ConcurrencyTracker } from './pi/concurrency.js';
import { ModelCurationStore } from './pi/model-curation.js';
import { OAuthFlowManager } from './pi/oauth-flows.js';
import { backfillOAuthCuratedModels } from './pi/oauth-curation-backfill.js';
import { loadLocalEnvFile } from './env.js';
import { registerBackendAuth } from './auth-gate.js';
import { writeLocalModelsFile } from './pi/local-models.js';
import { backfillLocalCuratedModels } from './pi/local-model-curation-backfill.js';

async function main() {
  loadLocalEnvFile();
  const config = loadConfig();
  writeLocalModelsFile(config);

  const db = getDb(getDbPath());
  // One probe at startup so the first sessions know whether Docker is there;
  // it refreshes itself on a TTL after that (see docker/session-deps.ts).
  const dockerAvailability = new DockerAvailability();
  // Then sweep containers orphaned by a crash or a kill -9, which dropSession()
  // never got to clean up. Chained onto the probe rather than awaited: a slow
  // or hung daemon must not delay the backend coming up.
  void dockerAvailability.refresh().then(async (available) => {
    if (!available) return;
    try {
      const line = describeSweep(await sweepOrphanedProjects(db, { isAvailable: () => true }));
      if (line) console.log(line);
    } catch { /* the next start sweeps again */ }
  });
  // The tool-decision audit trail (#281). DB-backed so decisions survive a
  // restart; created before the runtime so sessions record into it, and
  // decorated onto the app below so the audit route can read it.
  const approvalAudit = new DbApprovalAudit(db);
  // Located once at startup: unlike a Docker daemon, a browser binary does not
  // come and go. Null when the machine has none — the tools are then omitted.
  const browserSupport = createBrowserSupport();
  if (browserSupport) {
    // A browser is a real OS process; a backend that exits without closing its
    // browsers leaves them running headless with nothing driving them. Both
    // signals, and `once` so a second Ctrl-C still kills us promptly rather
    // than queueing another close.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void browserSupport.pool.closeAll().finally(() => process.exit(0));
      });
    }
  }
  const pi = await PiRuntime.create(defaultPiRuntimePaths(), {
    recallMemories: (cwd, query, limit) => recallForRepoPath(db, cwd, query, limit),
    mondayContext: (threadId) => buildMondayContext(db, threadId),
    mondayTools: (threadId) => buildMondayToolDeps(db, threadId),
    dockerTools: buildDockerToolDeps(dockerAvailability),
    tearDownServices: buildTearDownServices(dockerAvailability),
    browserTools: browserSupport?.browserTools,
    closeBrowser: browserSupport?.closeBrowser,
    // The thread's last-used model, persisted in the DB, so the orientation
    // block's vision line survives a restart. Best-effort — a missing row or a
    // read error just means "no vision asserted".
    sessionModelKey: (threadId) => {
      try {
        const row = db.prepare('SELECT last_model_key FROM chat_threads WHERE id = ?').get(threadId) as
          { last_model_key?: string } | undefined;
        return row?.last_model_key ?? undefined;
      } catch {
        return undefined;
      }
    },
    // Read config fresh per tool call so a `tool_policy` edit lands without a
    // session rebuild; degrade to built-in defaults if config can't be read.
    toolPolicy: (cwd) => {
      try {
        return resolveToolPolicy(loadConfig(), cwd);
      } catch {
        return EMPTY_TOOL_POLICY;
      }
    },
    approvalAudit,
  });

  const openRouterKey = resolveOpenRouterKey(config);
  if (openRouterKey) {
    await pi.auth.setRuntimeApiKey('openrouter', openRouterKey);
  }

  await initMemorySystem(db);
  const activityManager = new ActivityManager(db);
  const stopActivityListening = activityManager.startListening();
  startJiraSync(db, activityManager);
  startMondayPoll(db, activityManager.bus.emit.bind(activityManager.bus));
  // Shared between chat routes and the mission scheduler so an assistant_turn
  // mission claims the per-project/model slot the same way a chat turn does.
  // Created here (before the scheduler), then decorated onto the app below.
  const chatConcurrency = new ConcurrencyTracker();
  startMissionScheduler(db, {
    emit: activityManager.bus.emit.bind(activityManager.bus),
    pi,
    concurrency: chatConcurrency,
  });

  const app = Fastify({ logger: false });

  // @fastify/cors v11 defaults methods to 'GET,HEAD,POST' — omitting DELETE/PUT/PATCH
  // would make every such route fail CORS preflight over remote (Tailscale) exposure.
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  });
  await app.register(sensible);
  await app.register(websocket);

  // Bearer-token gate for remote (thin-client) exposure. When server.token is
  // set, every /api/* call except /api/health must present a matching bearer.
  // Empty ⇒ dev-open, preserving the loopback-only default. The resolved token
  // is also handed to the gateway so its loopback calls into this backend pass.
  const backendToken = resolveEnvVars(config.server.token || '');
  registerBackendAuth(app, backendToken);

  app.decorate('db', db);
  app.decorate('pi', pi);
  const modelCuration = new ModelCurationStore(join(getNexusDir(), 'model-curation.json'));
  await backfillOAuthCuratedModels(pi, modelCuration);
  await backfillLocalCuratedModels(pi, modelCuration);

  app.decorate('chatConcurrency', chatConcurrency);
  app.decorate('modelCuration', modelCuration);
  app.decorate('oauthFlows', new OAuthFlowManager(pi.auth));
  app.decorate('activity', activityManager);
  app.decorate('approvalAudit', approvalAudit);

  app.register(registerProjectRoutes);
  app.register(registerChatRoutes);
  app.register(registerAssistantRoutes);
  app.register(registerNextMessageRoutes);
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
  app.register(registerApprovalRoutes);
  app.register(async (f) => { await registerDockerRoutes(f, { isAvailable: () => dockerAvailability.isAvailable() }); });
  app.register(registerTrustRoutes);
  app.register(registerMissionRoutes);
  app.register(registerMondayRoutes);

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

  // Glasses cockpit gateway — a LAN listener sharing this process's pi + db so
  // the Even Realities G2 can drive Nexus sessions. A failure here must not take
  // down the main backend.
  // src/backend/index.ts → ../glasses/dist = src/glasses/dist (the in-repo UI build).
  const inRepoGlassesDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'glasses', 'dist');
  try {
    await startGateway({
      pi,
      db,
      mainPort: config.server.port,
      // The gateway steers turns / reads detail via loopback POSTs into this
      // backend; when the backend token is set those internal calls must carry
      // it too, else the glasses silently 401.
      mainToken: backendToken,
      config: {
        enabled: config.gateway.enabled,
        port: config.gateway.port,
        // One shared secret by default: the gateway inherits the main backend
        // token (server.token) when gateway.token isn't explicitly set, so a
        // single Nexus token guards both the backend and the glasses gateway.
        // Set gateway.token only to override / rotate the two independently.
        token: resolveEnvVars(config.gateway.token || '') || backendToken,
        recentMs: config.gateway.recent_minutes * 60 * 1000,
        // Default to the in-repo glasses build (src/glasses/dist) when neither
        // env nor config sets it, so a built checkout serves the cockpit UI with
        // no extra config. Guarded so it's simply omitted when not built.
        glassesDist: expandHome(
          process.env.NEXUS_GLASSES_DIST
          || config.gateway.glasses_dist
          || (existsSync(inRepoGlassesDist) ? inRepoGlassesDist : ''),
        ),
        stt: {
          provider: config.gateway.stt?.provider || 'deepgram',
          apiKey: resolveEnvVars(config.gateway.stt?.api_key || ''),
          language: config.gateway.stt?.language || 'en',
        },
      },
    });
  } catch (err) {
    console.error('[gateway] failed to start glasses gateway:', err);
  }
}

main();
