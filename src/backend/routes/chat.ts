import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { ChatThread, ChatMessage, PersonaConfig } from '@nexus/shared';
import { getRelevantMemories } from '../memory';
import { loadConfig, resolveOpenRouterKey } from '../config';
import fs from 'fs';
import path from 'path';

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

  fastify.post('/api/threads/:threadId/messages', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const body = request.body as { role: 'user' | 'assistant' | 'system'; content: string; attachments?: string; model?: string };

    const now = new Date().toISOString();
    const userMsg: ChatMessage = {
      id: uuid(),
      thread_id: threadId,
      role: 'user',
      content: body.content,
      attachments_json: body.attachments || '[]',
      created_at: now,
    };

    db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userMsg.id, userMsg.thread_id, userMsg.role, userMsg.content, userMsg.attachments_json, userMsg.created_at);
    db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, threadId);

    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(thread.project_id) as any;

    const model = body.model || 'openrouter/anthropic/claude-sonnet-4';
    const apiKey = resolveOpenRouterKey(loadConfig());

    let systemPrompt = 'You are a helpful assistant in NEXUS, an agent orchestration platform.';
    let memoryContext = '';

    if (project) {
      memoryContext = (await getRelevantMemories(db, project.id, body.content)).map(m => `- ${m}`).join('\n');
      const projectDocsDir = path.join(project.repo_path, 'project_docs');
      const docsList: string[] = [];
      for (const sub of ['specs', 'plans', 'uploads']) {
        const dir = path.join(projectDocsDir, sub);
        if (!fs.existsSync(dir)) continue;
        fs.readdirSync(dir).filter(f => !f.startsWith('.')).forEach(f => docsList.push(`${sub}/${f}`));
      }

      systemPrompt = `You are a helpful assistant in the NEXUS project "${project.name}".\n\n`;
      if (project.description) systemPrompt += `Project: ${project.description}\n`;
      systemPrompt += `Working directory: ${project.repo_path}\n`;
      if (docsList.length > 0) systemPrompt += `\nAvailable project documents:\n${docsList.map(d => `- ${d}`).join('\n')}\n`;
      systemPrompt += `\nUse these documents for context. Do not make up information not present in the conversation or documents.`;
    }

    if (!apiKey) {
      const assistantMsg: ChatMessage = {
        id: uuid(),
        thread_id: threadId,
        role: 'assistant',
        content: `[Config needed] Set OPENROUTER_API_KEY env variable to enable AI responses.\n\n${memoryContext ? 'Found memories:\n' + memoryContext : 'No relevant memories found.'}`,
        attachments_json: '[]',
        created_at: new Date().toISOString(),
      };
      db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(assistantMsg.id, assistantMsg.thread_id, assistantMsg.role, assistantMsg.content, assistantMsg.attachments_json, assistantMsg.created_at);
      db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(assistantMsg.created_at, threadId);
      return assistantMsg;
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://nexus.local',
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
            ...(memoryContext ? [{ role: 'system' as const, content: `Relevant memories:\n${memoryContext}` }] : []),
            { role: 'user', content: body.content },
          ],
          stream: false,
        }),
      });

      const data = await response.json() as any;
      const assistantContent = data.choices?.[0]?.message?.content || `[Error] ${data.error?.message || 'No response'}`;

      const assistantMsg: ChatMessage = {
        id: uuid(),
        thread_id: threadId,
        role: 'assistant',
        content: assistantContent,
        attachments_json: '[]',
        created_at: new Date().toISOString(),
      };

      db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(assistantMsg.id, assistantMsg.thread_id, assistantMsg.role, assistantMsg.content, assistantMsg.attachments_json, assistantMsg.created_at);
      db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(assistantMsg.created_at, threadId);

      if (project) {
        const { addMemory } = await import('../memory');
        try {
          await addMemory(db, {
            project_id: project.id,
            agent_id: thread.agent_id,
            category: 'chat',
            content: `Q: ${body.content.slice(0, 200)} → A: ${assistantContent.slice(0, 200)}`,
            metadata: { thread_id: threadId, source: 'chat' },
          });
        } catch { /* ignore */ }
      }

      return assistantMsg;
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: uuid(),
        thread_id: threadId,
        role: 'assistant',
        content: `[Error] ${err.message}`,
        attachments_json: '[]',
        created_at: new Date().toISOString(),
      };
      db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(errorMsg.id, errorMsg.thread_id, errorMsg.role, errorMsg.content, errorMsg.attachments_json, errorMsg.created_at);
      return errorMsg;
    }
  });

  fastify.post('/api/threads/:threadId/archive', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const now = new Date().toISOString();
    db.prepare('UPDATE chat_threads SET archived_at = ? WHERE id = ?').run(now, threadId);
    return { success: true };
  });
}
