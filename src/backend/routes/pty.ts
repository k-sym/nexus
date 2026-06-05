import { FastifyInstance } from 'fastify';
import { ChatThread } from '@nexus/shared';
import { PtyManager } from '../pty/manager';
import { spawnNodePty } from '../pty/node-pty-adapter';
import { buildLaunchCommand } from '../pty/launch-command';
import { parsePersonaLaunch } from '../persona-launch';

const manager = new PtyManager({ spawn: spawnNodePty });
const REAP_INTERVAL_MS = 60_000;
const MAX_IDLE_MS = 30 * 60_000;
const reaper = setInterval(() => manager.reap(MAX_IDLE_MS), REAP_INTERVAL_MS);
reaper.unref?.();

export async function registerPtyRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/threads/:threadId/pty', { websocket: true }, (socket, req) => {
    const { threadId } = req.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) { socket.close(1008, 'thread not found'); return; }

    const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(thread.project_id) as { repo_path: string } | undefined;
    const cwd = project?.repo_path || process.cwd();

    const persona = db.prepare('SELECT config_yaml FROM personas WHERE slug = ?').get(thread.agent_id) as { config_yaml: string } | undefined;
    const launch = persona ? parsePersonaLaunch(persona.config_yaml) : { provider: '', systemPrompt: '' };
    const stored = (thread.launch_command ?? '').trim();
    const computed = buildLaunchCommand({ provider: launch.provider, systemPrompt: launch.systemPrompt, sessionId: thread.agent_session_id ?? undefined });
    const baseCommand = stored || computed;
    // Auto-run: append a carriage return so the command executes on first spawn.
    // Empty => plain shell, no auto-run.
    const launchCommand = baseCommand ? `${baseCommand}\r` : '';

    manager.open(threadId, { cwd, cols: 80, rows: 24, launchCommand });

    const send = (data: string) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'output', data })); };
    manager.attach(threadId, send);

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input' && typeof msg.data === 'string') manager.input(threadId, msg.data);
      else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') manager.resize(threadId, msg.cols, msg.rows);
    });

    socket.on('close', () => manager.detach(threadId, send));
  });
}
