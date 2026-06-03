/**
 * NEXUS backend entry point.
 *
 * Boots a single Fastify process that hosts the HTTP API and starts three
 * background loops: the orchestrator (agent dispatch), the scheduler (cron),
 * and the Obsidian vault watcher. On first run it seeds default personas and
 * creates the ~/.nexus directory structure.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { getDb } from './db';
import { loadConfig, getDbPath, getNexusDir } from './config';
import { registerProjectRoutes } from './routes/projects';
import { registerChatRoutes } from './routes/chat';
import { registerPersonaRoutes } from './routes/personas';
import { registerOrchestratorRoutes } from './routes/orchestrator';
import { registerMemoryRoutes } from './routes/memory';
import { registerScheduleRoutes } from './routes/schedules';
import { registerSettingsRoutes } from './routes/settings';
import { registerStatusRoutes } from './routes/status';
import { registerTicketRoutes } from './routes/tickets';
import { registerNotificationRoutes } from './routes/notifications';
import { registerProviderRoutes, seedProviders } from './routes/providers';
import { startOrchestrator } from './orchestrator';
import { initMemorySystem } from './memory';
import { startScheduler } from './scheduler';
import { startJiraSync } from './jira/poll';

async function main() {
  const config = loadConfig();

  const db = getDb(getDbPath());
  seedPersonas(db);
  seedProviders(db);
  await initMemorySystem(db);
  startOrchestrator(db);
  if (config.scheduler.enabled) {
    startScheduler(db);
  }
  startJiraSync(db);

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(sensible);

  app.decorate('db', db);

  app.register(registerProjectRoutes);
  app.register(registerChatRoutes);
  app.register(registerPersonaRoutes);
  app.register(registerOrchestratorRoutes);
  app.register(registerMemoryRoutes);
  app.register(registerScheduleRoutes);
  app.register(registerSettingsRoutes);
  app.register(registerStatusRoutes);
  app.register(registerTicketRoutes);
  app.register(registerNotificationRoutes);
  app.register(registerProviderRoutes);

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.setErrorHandler((error, request, reply) => {
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

function seedPersonas(db: Database.Database) {
  const personasDir = path.join(getNexusDir(), 'personas');
  if (!fs.existsSync(personasDir)) return;

  const files = fs.readdirSync(personasDir).filter(f => f.endsWith('.yaml'));
  const existingSlugs = new Set(
    (db.prepare('SELECT slug FROM personas').all() as { slug: string }[]).map(r => r.slug)
  );

  for (const file of files) {
    const slug = file.replace('.yaml', '');
    if (existingSlugs.has(slug)) continue;

    try {
      const raw = fs.readFileSync(path.join(personasDir, file), 'utf-8');
      const config = yaml.load(raw) as any;
      const now = new Date().toISOString();
      db.prepare('INSERT OR IGNORE INTO personas (id, name, slug, config_yaml, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), config.name, slug, raw, now);
    } catch (err) {
      console.error(`Failed to seed persona ${slug}:`, err);
    }
  }
}

main();
