/**
 * Serialize a chat thread to JSONL — first line is a header (title, agent,
 * model, project slug, timestamps), subsequent lines are messages in
 * ChatMessage shape. Compatible with zosma-cowork's session format.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getNexusDir } from '../config';

export function exportThread(opts: {
  threadId: string;
  title: string;
  agentSlug: string;
  model?: string;
  provider?: string;
  projectSlug: string;
  messages: Array<{
    role: string;
    content: string;
    thinking?: string | null;
    tool_calls?: string | null;
    created_at: string;
  }>;
}): string {
  const dir = join(getNexusDir(), 'sessions', opts.projectSlug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opts.threadId}.jsonl`);

  const lines: string[] = [
    JSON.stringify({
      type: 'session' as const,
      version: 1,
      title: opts.title,
      agent: opts.agentSlug,
      model: opts.model || null,
      provider: opts.provider || null,
      createdAt: new Date().toISOString(),
      messageCount: opts.messages.length,
    }),
  ];

  for (const m of opts.messages) {
    lines.push(JSON.stringify({
      role: m.role,
      content: m.content,
      thinking: m.thinking || null,
      tool_calls: m.tool_calls || null,
      timestamp: m.created_at,
    }));
  }

  writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  return file;
}
