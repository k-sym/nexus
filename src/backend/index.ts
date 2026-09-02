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
import { registerDraftsRoutes } from './routes/drafts.js';
import { registerNightQueueRoutes } from './routes/night-queue.js';
import { registerWorkshopRoutes } from './routes/night-queue-workshop.js';
import { registerRoutinesRoutes } from './routes/routines.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerIdeaRoutes } from './routes/ideas.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { ApnsSender } from './apns/sender.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPiRoutes } from './routes/pi.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { DockerAvailability, buildDockerToolDeps, buildTearDownServices } from './docker/session-deps.js';
import { sweepOrphanedProjects, describeSweep } from './docker/sweep.js';
import { createBrowserSupport } from './browser/session-deps.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { resolveToolPolicy, EMPTY_TOOL_POLICY } from './pi/tool-policy-config.js';
import { DbApprovalAudit, summarizeToolInput } from './approvals/audit.js';
import { registerTrustRoutes } from './routes/trust.js';
import { registerMondayRoutes } from './routes/monday.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerNextMessageRoutes } from './routes/next-message.js';
import { registerAgentBridgeRoutes, createManagedTurnRunner } from './routes/agent-bridge.js';
import { AgentBridgeService } from './agent-bridge/service.js';
import { initMemorySystem, recallForRepoPath } from './memory/index.js';
import { startJiraSync } from './jira/poll.js';
import { startMondayPoll } from './monday/poll.js';
import { buildMondayContext, buildMondayToolDeps } from './monday/session-deps.js';
import { buildHelpersToolDeps } from './helpers/resolve.js';
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
import {
  createHealthProbe,
  createListenerWatchdog,
  installProcessGuards,
  installShutdownHandlers,
  logError,
  logInfo,
  watchServerClose,
} from './supervise.js';

async function main() {
  loadLocalEnvFile();
  const config = loadConfig();
  writeLocalModelsFile(config);

  const db = getDb(getDbPath());
  const agentBridge = new AgentBridgeService(db, config.agent_bridge);
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
  // A browser is a real OS process; a backend that exits without closing its
  // browsers leaves them running headless with nothing driving them. Installed
  // unconditionally (cleanup is a no-op without a browser) so that SIGTERM
  // always produces a prompt, logged exit — an unbounded close was why a wedged
  // backend could ignore `launchctl kickstart -k` indefinitely.
  const shutdown = installShutdownHandlers({
    cleanup: async () => {
      await Promise.all([
        browserSupport?.pool.closeAll(),
        agentBridge.stop(),
      ]);
    },
  });
  const pi = await PiRuntime.create(defaultPiRuntimePaths(), {
    recallMemories: (cwd, query, limit) => recallForRepoPath(db, cwd, query, limit),
    mondayContext: (threadId) => buildMondayContext(db, threadId),
    mondayTools: (threadId) => buildMondayToolDeps(db, threadId),
    dockerTools: buildDockerToolDeps(dockerAvailability),
    tearDownServices: buildTearDownServices(dockerAvailability),
    browserTools: browserSupport?.browserTools,
    closeBrowser: browserSupport?.closeBrowser,
    // API helpers (#291): resolved from config fresh per session, so enabling a
    // provider in Settings takes effect on the next thread without a restart.
    // Args ignored — helpers are global config, not per-thread. Degrade to null
    // on any read error so a broken config never blocks session creation.
    helpersTools: () => {
      try {
        return buildHelpersToolDeps(loadConfig());
      } catch {
        return null;
      }
    },
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

  // iOS push (M5). Inert until apns.enabled with a resolvable key (ApnsSender
  // no-ops otherwise). Two hooks: a pending tool-gate approval (always worth a
  // ping — it blocks the run), and a long run finishing. Listeners live for the
  // process; a throwing push can't wedge the broker (both buses isolate them).
  const apns = new ApnsSender(db);
  pi.approvals.subscribe((event) => {
    if (event.type !== 'pending') return;
    const view = event.view;
    const thread = db.prepare('SELECT title, project_id FROM chat_threads WHERE id = ?').get(view.threadId) as
      { title?: string; project_id?: string } | undefined;
    const project = thread?.project_id
      ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(thread.project_id) as { name?: string } | undefined)
      : undefined;
    const where = [project?.name, thread?.title].filter(Boolean).join(' / ') || 'a thread';
    // Lead with WHAT wants to run (#391): the lock screen is where Allow/Deny
    // gets weighed, and "bash wants to run in <auto-generated thread title>"
    // told the user everything except the command. The summary is
    // model-authored text, but it renders in full on the card one tap later —
    // clipping keeps a hostile input from flooding the banner, hiding it here
    // would only move the read one tap later. Project name stays as context;
    // the thread title (often a model-written sentence) earns no banner space
    // when a summary exists.
    const summary = summarizeToolInput(view.input).slice(0, 120);
    void apns.notify({
      title: `Approval needed — ${view.toolName}`,
      body: summary ? `${summary} · ${project?.name ?? 'a thread'}` : `${view.toolName} wants to run in ${where}.`,
      deepLink: `approval:${view.toolCallId}`,
      threadId: view.threadId,
      // Badge = total gates awaiting a decision across all threads.
      badge: pi.approvals.listPending().length,
    });
  });
  activityManager.bus.subscribe((event) => {
    if (event.type !== 'stop') return;
    if (event.kind !== 'chat_turn' && event.kind !== 'assistant_stream') return;
    // Only ping for longer runs, so ordinary quick replies don't spam.
    if ((event.durationMs ?? 0) < 30_000) return;
    const status = event.status ?? 'completed';
    void apns.notify({
      title: status === 'succeeded' ? 'Run finished' : `Run ${status}`,
      body: event.title || 'Your agent run has finished.',
      deepLink: event.threadId ? `thread:${event.threadId}` : 'open:',
      threadId: event.threadId ?? undefined,
      // Keep the badge in sync with any still-pending approvals.
      badge: pi.approvals.listPending().length,
    });
  });

  startJiraSync(db, activityManager);
  startMondayPoll(db, activityManager.bus.emit.bind(activityManager.bus));
  // Every potentially mutating chat run claims a per-project working-tree slot.
  const chatConcurrency = new ConcurrencyTracker();

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

  app.decorate('chatConcurrency', chatConcurrency);
  app.decorate('modelCuration', modelCuration);
  app.decorate('oauthFlows', new OAuthFlowManager(pi.auth));
  app.decorate('activity', activityManager);
  app.decorate('approvalAudit', approvalAudit);
  app.decorate('apns', apns);
  app.decorate('agentBridge', agentBridge);

  app.register(registerProjectRoutes);
  app.register(registerChatRoutes);
  app.register(registerAssistantRoutes);
  app.register(registerNextMessageRoutes);
  app.register(registerOrchestratorRoutes);
  app.register(registerMemoryRoutes);
  app.register(registerSettingsRoutes);
  app.register(registerStatusRoutes);
  app.register(registerRoutinesRoutes);
  app.register(registerNightQueueRoutes);
  app.register(registerWorkshopRoutes);
  app.register(registerDraftsRoutes);
  app.register(registerTicketRoutes);
  app.register(registerIdeaRoutes);
  app.register(registerNotificationRoutes);
  app.register(registerDeviceRoutes);
  app.register(registerAuthRoutes);
  app.register(registerPiRoutes);
  app.register(registerActivityRoutes);
  app.register(registerApprovalRoutes);
  // The human-facing view of a thread's headless browser. Wired to the same
  // browser support the tools use, so the panel reports available only when the
  // feature is on AND a browser was found. Peeks — polling never launches one.
  app.register(async (f) => {
    await registerBrowserRoutes(f, {
      enabled: () => browserSupport != null && browserSupport.isEnabled(),
      view: browserSupport ? (threadId) => browserSupport.viewFor(threadId) : undefined,
    });
  });
  app.register(registerTrustRoutes);
  app.register(registerMondayRoutes);
  app.register(registerAgentBridgeRoutes, {
    service: agentBridge,
    runManagedTurn: createManagedTurnRunner({
      port: config.server.port,
      token: config.server.token || '',
    }),
  });

  // Dev-only helpers (e.g. POST /api/dev/test-push). Never registered in
  // production; still behind the bearer-token gate.
  if (process.env.NODE_ENV !== 'production') {
    app.register(registerDevRoutes);
  }

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.setErrorHandler((error, request, reply) => {
    // Fastify's logger is disabled, so app.log.error writes nowhere; without
    // this every 500 left the launchd log completely silent.
    logError('request', `${request.method} ${request.url} failed`, error);
    const err = error as any;
    const statusCode = err.statusCode || 500;
    reply.status(statusCode).send({ error: err.message });
  });

  try {
    await app.listen({ port: config.server.port, host: '127.0.0.1' });
    logInfo('backend', `NEXUS backend running on http://127.0.0.1:${config.server.port}`);
    agentBridge.start();
  } catch (err) {
    // app.log.error wrote nowhere (logger:false), so a failed bind used to exit
    // 1 with an empty log and launchd restarted into the same failure forever.
    logError('backend', `could not listen on 127.0.0.1:${config.server.port}`, err);
    process.exit(1);
  }

  // Losing the listener while the process lives is the failure this guards
  // against: launchd's KeepAlive only restarts a process that exits, so a
  // backend serving nothing must take itself down rather than sit there.
  const die = (reason: string): never => {
    logError('backend', `${reason} — exiting so launchd restarts the service`);
    process.exit(1);
  };
  watchServerClose(app.server, die, shutdown.isShuttingDown);
  createListenerWatchdog({
    probe: createHealthProbe({ port: config.server.port }),
    onDead: die,
  }).start();

  // Curating the model catalog can reach the network, and pi's catalog fetch
  // has no timeout of its own — awaited before listen it could stall the whole
  // boot short of binding the port. Nothing serves stale results in the
  // meantime: an unsynced provider simply curates on the next request.
  try {
    await backfillOAuthCuratedModels(pi, modelCuration);
    await backfillLocalCuratedModels(pi, modelCuration);
  } catch (err) {
    logError('model-curation', 'curated-model backfill failed; continuing', err);
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
    logError('gateway', 'failed to start the glasses gateway', err);
  }
}

installProcessGuards();

main().catch((err) => {
  logError('backend', 'backend failed to start', err);
  process.exit(1);
});
