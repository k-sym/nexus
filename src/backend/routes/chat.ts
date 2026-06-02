import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import yaml from 'js-yaml';
import { ChatThread, ChatMessage, PersonaConfig, Provider } from '@nexus/shared';
import { getRelevantMemories, addMemory } from '../memory';
import { loadConfig } from '../config';
import { runPersona } from '../orchestrator/providers';
import { getProviderById } from './providers';

const MAX_HISTORY = 12;

export async function registerChatRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/projects/:projectId/threads', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const rows = db.prepare('SELECT * FROM chat_threads WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC').all(projectId);
    return rows as ChatThread[];
  });

  fastify.post('/api/projects/:projectId/threads', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { agent_id: string };

    const now = new Date().toISOString();
    const thread: ChatThread = {
      id: uuid(),
      project_id: projectId,
      agent_id: body.agent_id,
      title: 'New Chat',
      created_at: now,
      updated_at: now,
      archived_at: null,
    };

    db.prepare('INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(thread.id, thread.project_id, thread.agent_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at);

    return thread;
  });

  fastify.get('/api/threads/:threadId/messages', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId);
    return rows as ChatMessage[];
  });

  function insertMessage(threadId: string, role: ChatMessage['role'], content: string, attachments = '[]'): ChatMessage {
    const msg: ChatMessage = {
      id: uuid(),
      thread_id: threadId,
      role,
      content,
      attachments_json: attachments,
      created_at: new Date().toISOString(),
    };
    db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msg.id, msg.thread_id, msg.role, msg.content, msg.attachments_json, msg.created_at);
    db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(msg.created_at, threadId);
    return msg;
  }

  function resolvePersona(agentId: string): PersonaConfig | null {
    const row = db.prepare('SELECT config_yaml FROM personas WHERE slug = ?').get(agentId) as { config_yaml: string } | undefined;
    if (!row) return null;
    try {
      return yaml.load(row.config_yaml) as PersonaConfig;
    } catch {
      return null;
    }
  }

  /**
   * Post a user message and get the assistant reply from the thread's agent.
   * The thread's persona (agent_id) decides which harness runs: Claude Code /
   * Codex subprocess, or an OpenAI-compatible HTTP model (OpenRouter / local).
   * Synchronous v1: we await the full reply, then return it.
   */
  fastify.post('/api/threads/:threadId/messages', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const body = request.body as { content: string; attachments?: string };
    const config = loadConfig();

    // 1. Persist the user's turn.
    insertMessage(threadId, 'user', body.content, body.attachments || '[]');

    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) return insertMessage(threadId, 'assistant', '[Error] Thread not found.');
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(thread.project_id) as any;

    // 2. Resolve the thread's agent persona.
    const persona = resolvePersona(thread.agent_id);
    if (!persona) {
      return insertMessage(threadId, 'assistant', `[No agent] No persona found for "${thread.agent_id}". Add one under Personas, or pick a different agent.`);
    }

    // 3. Build the prompt body: relevant memories + recent thread history.
    const memories = project ? await getRelevantMemories(db, project.id, body.content) : [];
    const memoryBlock = memories.length ? `Relevant memories:\n${memories.map(m => `- ${m}`).join('\n')}\n\n` : '';
    const history = db.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId) as { role: string; content: string }[];
    const historyBlock = history
      .slice(-MAX_HISTORY)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const promptBody = `${memoryBlock}${historyBlock}\n\nAssistant:`;

    const workspace = project?.repo_path || process.cwd();

    // 4. Resolve the persona's provider record (if any) and run it (synchronous).
    const provider: Provider | undefined = persona.provider_id ? getProviderById(db, persona.provider_id) : undefined;
    console.log(`[chat] running ${provider ? `${provider.name} (${provider.kind})` : persona.provider} model="${persona.model || provider?.default_model || ''}" for "${persona.slug}" in ${workspace}`);
    const result = await runPersona(persona, promptBody, workspace, config, () => {}, provider);
    if (!result.ok) {
      console.error(`[chat] ${persona.provider} (${persona.model}) failed in ${workspace}: ${result.error}`);
    }
    const content = result.ok
      ? (result.output.trim() || '[empty response]')
      : `[${persona.provider} error] ${result.error || 'unknown error'}`;

    // 5. Persist the assistant turn + archive the exchange to memory.
    const assistantMsg = insertMessage(threadId, 'assistant', content);

    if (project && result.ok) {
      addMemory(db, {
        project_id: project.id,
        agent_id: thread.agent_id,
        category: 'chat',
        content: `Q: ${body.content.slice(0, 200)} → A: ${content.slice(0, 200)}`,
        metadata: { thread_id: threadId, source: 'chat', provider: persona.provider },
      }).catch(() => { /* best-effort */ });
    }

    return assistantMsg;
  });

  fastify.post('/api/threads/:threadId/archive', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const now = new Date().toISOString();
    db.prepare('UPDATE chat_threads SET archived_at = ? WHERE id = ?').run(now, threadId);
    return { success: true };
  });

  // Permanently delete a thread and its messages (chat_messages cascade on FK).
  fastify.delete('/api/threads/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string };
    db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId);
    return { success: true };
  });
}
