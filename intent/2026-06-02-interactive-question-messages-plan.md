# Interactive Question Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chat agent ask the user a question with selectable answer options (single- and multi-select, plus free-text), rendered as an interactive card; the user's selection becomes the next turn that continues the conversation.

**Architecture:** Turn-based and text-only (no streaming, no real tool-calls). The agent ends its reply with a fenced ` ```ask ` JSON block; the backend parses it out of the provider's text output and persists a `question` message. The frontend renders a `QuestionCard`; submitting posts to a new `/answer` route which records an `answer` message and runs a continuation turn through the existing `runPersona` path.

**Tech Stack:** TypeScript, Fastify + better-sqlite3 (backend), React + Tailwind (frontend), `node:test` via `tsx --test` (tests). Spec: `project_docs/specs/2026-06-02-interactive-question-messages-design.md`.

---

## File Structure

- **Modify** `src/shared/index.ts` — extend `ChatMessage`; add `QuestionOption`, `Question`, `Ask`, `Reply`, `AnswerSet` types.
- **Modify** `src/backend/db.ts` — add `message_type` + `structured_json` columns to `chat_messages` (CREATE + guarded ALTER).
- **Create** `src/backend/chat/ask.ts` — `parseAskBlock`, `buildAnswerSummary`, `ASK_CONVENTION`. Pure, no DB/IO.
- **Modify** `src/backend/orchestrator/providers.ts` — inject `ASK_CONVENTION` into the system prompt for all provider paths.
- **Modify** `src/backend/routes/chat.ts` — extend `insertMessage`; extract a `respond()` helper; parse questions; add `POST /api/threads/:id/answer`.
- **Create** `src/backend/test/ask.test.ts` — unit tests for `parseAskBlock` + `buildAnswerSummary`.
- **Create** `src/backend/test/db.test.ts` — assert the migration adds the columns.
- **Modify** `src/frontend/src/api.ts` — add `chat.answer`.
- **Create** `src/frontend/src/components/QuestionCard.tsx` — the interactive card.
- **Modify** `src/frontend/src/components/ChatPanel.tsx` — render branch + optimistic-message fix.

**Note on testing scope:** The backend has no HTTP/DB integration harness (existing tests are pure unit tests of `parseCron`, `buildOpenCodeArgs`, etc.). We therefore unit-test the pure pieces (`parseAskBlock`, `buildAnswerSummary`) and the migration, and verify route wiring + frontend manually (Task 10). Don't build a new integration harness — that's out of scope.

---

### Task 1: Shared types

**Files:**
- Modify: `src/shared/index.ts:74-81` (ChatMessage) and after line 88 (new types)

- [ ] **Step 1: Extend `ChatMessage`**

Replace the `ChatMessage` interface (currently lines 74-81) with:

```ts
export interface ChatMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments_json: string;
  /** 'text' (default), 'question' (assistant asks), or 'answer' (user's selection). */
  message_type: 'text' | 'question' | 'answer';
  /** For 'question': a serialized Ask. For 'answer': a serialized AnswerSet. Else null. */
  structured_json: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Add the question/answer types**

Immediately after the `FileAttachment` interface (after line 88), add:

```ts
/** One selectable option in a question. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** A single question an agent asks the user. Normalized: multiple/custom always set. */
export interface Question {
  /** Short label, ≤30 chars. */
  header: string;
  /** The full question text. */
  question: string;
  options: QuestionOption[];
  /** Allow selecting more than one option. */
  multiple: boolean;
  /** Allow a free-text ("Type your own answer") response. */
  custom: boolean;
}

/** The payload an agent emits in a fenced ```ask``` block. */
export interface Ask {
  questions: Question[];
}

/** The user's answer to one question (index-aligned with Ask.questions). */
export interface Reply {
  /** Carried for display only — not a join key (headers may collide). */
  header: string;
  /** Selected option labels. */
  selected: string[];
  /** Free-text answer, when the user used "Type your own answer". */
  custom?: string;
}

/** The full set of replies stored on an 'answer' message. */
export interface AnswerSet {
  replies: Reply[];
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run --workspace=src/shared typecheck`
Expected: PASS (no output / exit 0). Backend/frontend will fail to typecheck until later tasks — that's expected; don't run them yet.

- [ ] **Step 4: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): question/answer message types"
```

---

### Task 2: DB migration

**Files:**
- Modify: `src/backend/db.ts:79-86` (CREATE TABLE) and after line 189 (guarded ALTER)
- Test: `src/backend/test/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/db.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';

test('chat_messages has message_type + structured_json columns', () => {
  const base = join(tmpdir(), `nexus-dbtest-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(chat_messages)') as { name: string }[]).map(c => c.name);
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(cols.includes('message_type'), 'message_type column present');
  assert.ok(cols.includes('structured_json'), 'structured_json column present');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test`
Expected: FAIL — the assertions report the columns are missing.

- [ ] **Step 3: Add the columns to CREATE TABLE**

In `src/backend/db.ts`, change the `chat_messages` CREATE (lines 79-86) so the column list reads:

```sql
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      attachments_json TEXT DEFAULT '[]',
      message_type TEXT NOT NULL DEFAULT 'text',
      structured_json TEXT,
      created_at TEXT NOT NULL
    );
```

- [ ] **Step 4: Add the guarded ALTER migration**

In `src/backend/db.ts`, immediately after the providers migration loop (after line 189, before the closing `}` of `runMigrations`), add:

```ts
  // Chat message structured-question migrations (DBs created before this feature).
  const msgCols = db.pragma('table_info(chat_messages)') as { name: string }[];
  const msgColNames = new Set(msgCols.map(c => c.name));
  const msgMigrations: Array<[string, string]> = [
    ['message_type', "ALTER TABLE chat_messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'"],
    ['structured_json', 'ALTER TABLE chat_messages ADD COLUMN structured_json TEXT'],
  ];
  for (const [col, sql] of msgMigrations) {
    if (!msgColNames.has(col)) {
      db.exec(sql);
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run --workspace=src/backend test`
Expected: PASS — including the new `chat_messages has message_type…` test.

- [ ] **Step 6: Commit**

```bash
git add src/backend/db.ts src/backend/test/db.test.ts
git commit -m "feat(backend): chat_messages message_type + structured_json migration"
```

---

### Task 3: The `ask` parser + summary builder

**Files:**
- Create: `src/backend/chat/ask.ts`
- Test: `src/backend/test/ask.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/backend/test/ask.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskBlock, buildAnswerSummary } from '../chat/ask';
import type { Ask } from '@nexus/shared';

const VALID = [
  'Pick a database for the project.',
  '',
  '```ask',
  '{ "questions": [ { "header": "Database", "question": "Which DB?",',
  '  "options": [ {"label":"Postgres","description":"server"}, {"label":"SQLite","description":"file"} ] } ] }',
  '```',
].join('\n');

test('parseAskBlock extracts preamble + normalized ask', () => {
  const parsed = parseAskBlock(VALID);
  assert.ok(parsed);
  assert.equal(parsed!.preamble, 'Pick a database for the project.');
  assert.equal(parsed!.ask.questions.length, 1);
  const q = parsed!.ask.questions[0];
  assert.equal(q.header, 'Database');
  assert.equal(q.options.length, 2);
  assert.equal(q.multiple, false); // default
  assert.equal(q.custom, true);    // default
});

test('parseAskBlock preserves multiple + custom flags', () => {
  const src = '```ask\n{"questions":[{"header":"H","question":"Q","multiple":true,"custom":false,"options":[{"label":"A","description":""}]}]}\n```';
  const parsed = parseAskBlock(src);
  assert.ok(parsed);
  assert.equal(parsed!.ask.questions[0].multiple, true);
  assert.equal(parsed!.ask.questions[0].custom, false);
});

test('parseAskBlock returns null for malformed JSON', () => {
  const src = 'text\n```ask\n{ not json }\n```';
  assert.equal(parseAskBlock(src), null);
});

test('parseAskBlock returns null when no block present', () => {
  assert.equal(parseAskBlock('just a normal reply'), null);
});

test('parseAskBlock accepts <ask_user> fallback', () => {
  const src = 'hi <ask_user>{"questions":[{"header":"H","question":"Q","options":[{"label":"A","description":"d"}]}]}</ask_user>';
  const parsed = parseAskBlock(src);
  assert.ok(parsed);
  assert.equal(parsed!.preamble, 'hi');
  assert.equal(parsed!.ask.questions[0].options[0].label, 'A');
});

test('parseAskBlock returns null when a question has no options', () => {
  const src = '```ask\n{"questions":[{"header":"H","question":"Q","options":[]}]}\n```';
  assert.equal(parseAskBlock(src), null);
});

test('buildAnswerSummary joins questions with selected + custom', () => {
  const ask: Ask = { questions: [
    { header: 'DB', question: 'Which DB?', options: [], multiple: false, custom: true },
    { header: 'Lang', question: 'Which language?', options: [], multiple: true, custom: true },
  ] };
  const summary = buildAnswerSummary(ask, [
    { header: 'DB', selected: ['Postgres'] },
    { header: 'Lang', selected: ['TS', 'Go'], custom: 'Rust' },
  ]);
  assert.match(summary, /"Which DB\?"="Postgres"/);
  assert.match(summary, /"Which language\?"="TS, Go, Rust"/);
  assert.match(summary, /^User has answered your questions:/);
});

test('buildAnswerSummary marks missing replies as Unanswered', () => {
  const ask: Ask = { questions: [{ header: 'H', question: 'Q', options: [], multiple: false, custom: true }] };
  const summary = buildAnswerSummary(ask, []);
  assert.match(summary, /"Q"="Unanswered"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run --workspace=src/backend test`
Expected: FAIL — `Cannot find module '../chat/ask'`.

- [ ] **Step 3: Implement the parser module**

Create `src/backend/chat/ask.ts`:

```ts
/**
 * Parse a fenced ```ask``` block (or <ask_user> fallback) out of an agent's text
 * output into a structured Ask, and build the human-readable answer summary that
 * becomes the user's continuation turn. Pure — no DB or IO. See
 * project_docs/specs/2026-06-02-interactive-question-messages-design.md.
 */
import type { Ask, Question, QuestionOption, Reply } from '@nexus/shared';

const FENCE_RE = /```ask\s*\n([\s\S]*?)```/;
const TAG_RE = /<ask_user>\s*([\s\S]*?)<\/ask_user>/;

export interface ParsedAsk {
  /** Text before the block, trimmed (the question's preamble). */
  preamble: string;
  ask: Ask;
}

/** Extract the first valid ask block. Returns null if absent or malformed. */
export function parseAskBlock(output: string): ParsedAsk | null {
  if (!output) return null;

  let raw: string | null = null;
  let start = -1;

  const fence = FENCE_RE.exec(output);
  if (fence) {
    raw = fence[1];
    start = fence.index;
  } else {
    const tag = TAG_RE.exec(output);
    if (tag) {
      raw = tag[1];
      start = tag.index;
    }
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  const ask = normalizeAsk(parsed);
  if (!ask) return null;

  return { preamble: output.slice(0, start).trim(), ask };
}

/** Validate + apply defaults (multiple=false, custom=true). Null on bad shape. */
function normalizeAsk(parsed: unknown): Ask | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const questions = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const out: Question[] = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') return null;
    const qq = q as Record<string, unknown>;
    if (typeof qq.header !== 'string' || typeof qq.question !== 'string') return null;
    if (!Array.isArray(qq.options) || qq.options.length === 0) return null;

    const options: QuestionOption[] = [];
    for (const o of qq.options) {
      if (!o || typeof (o as Record<string, unknown>).label !== 'string') return null;
      const oo = o as Record<string, unknown>;
      options.push({
        label: oo.label as string,
        description: typeof oo.description === 'string' ? oo.description : '',
      });
    }

    out.push({
      header: (qq.header as string).slice(0, 30),
      question: qq.question as string,
      options,
      multiple: qq.multiple === true,
      custom: qq.custom !== false,
    });
  }
  return { questions: out };
}

/** Build the OpenCode-style summary fed back to the agent as the next turn. */
export function buildAnswerSummary(ask: Ask, replies: Reply[]): string {
  const parts = ask.questions.map((q, i) => {
    const r = replies[i];
    const chosen = r ? [...r.selected, ...(r.custom ? [r.custom] : [])] : [];
    const ans = chosen.length ? chosen.join(', ') : 'Unanswered';
    return `"${q.question}"="${ans}"`;
  });
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
}

/** Injected into every persona's system prompt so any provider can ask. */
export const ASK_CONVENTION = [
  '## Asking the user questions',
  '',
  'When you need a decision, preference, or clarification, you MAY end your reply with a single',
  'fenced code block tagged `ask` containing JSON:',
  '',
  '```ask',
  '{ "questions": [ { "header": "Short label", "question": "Full question?", "multiple": false,',
  '  "options": [ { "label": "Option A", "description": "what this means" },',
  '               { "label": "Option B", "description": "..." } ] } ] }',
  '```',
  '',
  'Rules:',
  '- "header" is a short label (max 30 chars). Each option has a "label" (1-5 words) and "description".',
  '- A "Type your own answer" free-text option is added automatically — do NOT add your own "Other" option.',
  '- If you recommend an option, put it first and suffix its label with "(Recommended)".',
  '- Set "multiple": true to let the user select more than one option.',
  '- Put the block LAST, after any explanatory text. Only use it when you genuinely need the user’s input.',
].join('\n');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test`
Expected: PASS — all `parseAskBlock` + `buildAnswerSummary` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backend/chat/ask.ts src/backend/test/ask.test.ts
git commit -m "feat(backend): ask-block parser + answer summary + convention text"
```

---

### Task 4: Inject the convention into the system prompt

**Files:**
- Modify: `src/backend/orchestrator/providers.ts` (imports near top; `runPersona` at lines 309-341)

- [ ] **Step 1: Import the convention**

Near the other relative imports at the top of `src/backend/orchestrator/providers.ts`, add:

```ts
import { ASK_CONVENTION } from '../chat/ask';
```

- [ ] **Step 2: Build the augmented system prompt once and use it on every path**

Replace the body of `runPersona` from the `const withSystem = …` line (317) down through the end of the provider-record `if (provider) { … }` block (line 341) with:

```ts
  const sys = persona.system_prompt
    ? `${persona.system_prompt}\n\n${ASK_CONVENTION}`
    : ASK_CONVENTION;
  const withSystem = `${sys}\n\n${prompt}`;
  const personaWithSys: PersonaConfig = { ...persona, system_prompt: sys };

  // Provider-first: a persona that references a Provider record dispatches by the
  // provider's kind + endpoint. (Legacy `provider` enum below is the fallback.)
  if (provider) {
    const model = persona.model || provider.default_model || '';
    switch (provider.kind) {
      case 'claude_code': {
        const allowed = mapToolsToClaude(persona.tools);
        const args = [...(config.claude_code.args ?? []), ...(allowed.length ? ['--allowedTools', allowed.join(',')] : [])];
        return runClaudeCode(workspace, withSystem, onOutput, { command: config.claude_code.command, args }, claudeModelAlias(model));
      }
      case 'codex':
        return runCodex(workspace, withSystem, onOutput, { command: config.codex.command, args: config.codex.args }, model);
      case 'opencode':
        return runOpenCode(workspace, withSystem, onOutput, model, provider.args);
      case 'openai_compat':
      case 'hermes': {
        const baseUrl = resolveEnvVars(provider.base_url || '');
        const apiKey = resolveEnvVars(provider.api_key || '');
        const headers = /openrouter\.ai/.test(baseUrl) ? { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS' } : undefined;
        return runOpenAICompatible({ ...personaWithSys, model }, prompt, { baseUrl, apiKey, headers }, onOutput);
      }
    }
  }
```

- [ ] **Step 3: Thread the augmented prompt through the legacy HTTP paths**

In the legacy `switch (persona.provider)` block (lines 343-374), the CLI cases already use `withSystem`. Update the two HTTP cases to use `personaWithSys` instead of `persona`:

```ts
    case 'openrouter':
      return runOpenAICompatible(
        personaWithSys,
        prompt,
        { baseUrl: OPENROUTER_BASE, apiKey: resolveOpenRouterKey(config), headers: { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS' } },
        onOutput,
      );
    case 'local':
    case 'ollama':
      return runOpenAICompatible(personaWithSys, prompt, { baseUrl: config.models.local.base_url, apiKey: config.models.local.api_key }, onOutput);
```

(The CLI cases at lines 344-355 are unchanged — they already build `withSystem` from the persona's system prompt, which now includes the convention.)

- [ ] **Step 4: Typecheck**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/orchestrator/providers.ts
git commit -m "feat(backend): inject ask convention into persona system prompt (all providers)"
```

---

### Task 5: Chat route — extend insertMessage, extract respond(), parse questions

**Files:**
- Modify: `src/backend/routes/chat.ts` (imports; `insertMessage` 48-61; messages route 79-134)

- [ ] **Step 1: Add imports**

In `src/backend/routes/chat.ts`, extend the shared-types import (line 4) and add the parser import:

```ts
import { ChatThread, ChatMessage, PersonaConfig, Provider, Ask, Reply, AnswerSet } from '@nexus/shared';
```

Add after the existing imports (after line 8):

```ts
import { parseAskBlock, buildAnswerSummary } from '../chat/ask';
```

- [ ] **Step 2: Extend `insertMessage` to carry message_type + structured_json**

Replace `insertMessage` (lines 48-61) with:

```ts
  function insertMessage(
    threadId: string,
    role: ChatMessage['role'],
    content: string,
    attachments = '[]',
    messageType: ChatMessage['message_type'] = 'text',
    structuredJson: string | null = null,
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuid(),
      thread_id: threadId,
      role,
      content,
      attachments_json: attachments,
      message_type: messageType,
      structured_json: structuredJson,
      created_at: new Date().toISOString(),
    };
    db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, message_type, structured_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(msg.id, msg.thread_id, msg.role, msg.content, msg.attachments_json, msg.message_type, msg.structured_json, msg.created_at);
    db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(msg.created_at, threadId);
    return msg;
  }
```

- [ ] **Step 3: Add a `respond()` helper that both routes share**

Immediately after `resolvePersona` (after line 71), add:

```ts
  /**
   * Run the thread's agent for one turn: build prompt (memories + history), call
   * the provider, then persist either a `question` message (if the reply contains
   * an ask block) or a plain text message. `triggerText` is the user input that
   * caused this turn (used for memory relevance + archival).
   */
  async function respond(threadId: string, triggerText: string): Promise<ChatMessage> {
    const config = loadConfig();

    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) return insertMessage(threadId, 'assistant', '[Error] Thread not found.');
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(thread.project_id) as any;

    const persona = resolvePersona(thread.agent_id);
    if (!persona) {
      return insertMessage(threadId, 'assistant', `[No agent] No persona found for "${thread.agent_id}". Add one under Personas, or pick a different agent.`);
    }

    const memories = project ? await getRelevantMemories(db, project.id, triggerText) : [];
    const memoryBlock = memories.length ? `Relevant memories:\n${memories.map(m => `- ${m}`).join('\n')}\n\n` : '';
    const history = db.prepare('SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId) as { role: string; content: string }[];
    const historyBlock = history
      .slice(-MAX_HISTORY)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const promptBody = `${memoryBlock}${historyBlock}\n\nAssistant:`;
    const workspace = project?.repo_path || process.cwd();

    const provider: Provider | undefined = persona.provider_id ? getProviderById(db, persona.provider_id) : undefined;
    console.log(`[chat] running ${provider ? `${provider.name} (${provider.kind})` : persona.provider} model="${persona.model || provider?.default_model || ''}" for "${persona.slug}" in ${workspace}`);
    const result = await runPersona(persona, promptBody, workspace, config, () => {}, provider);
    if (!result.ok) {
      console.error(`[chat] ${persona.provider} (${persona.model}) failed in ${workspace}: ${result.error}`);
    }
    const content = result.ok
      ? (result.output.trim() || '[empty response]')
      : `[${persona.provider} error] ${result.error || 'unknown error'}`;

    // If the agent emitted an ask block, persist a structured question message.
    const parsed = result.ok ? parseAskBlock(result.output) : null;
    const assistantMsg = parsed
      ? insertMessage(threadId, 'assistant', parsed.preamble, '[]', 'question', JSON.stringify(parsed.ask))
      : insertMessage(threadId, 'assistant', content);

    if (project && result.ok) {
      addMemory(db, {
        project_id: project.id,
        agent_id: thread.agent_id,
        category: 'chat',
        content: `Q: ${triggerText.slice(0, 200)} → A: ${content.slice(0, 200)}`,
        metadata: { thread_id: threadId, source: 'chat', provider: persona.provider },
      }).catch(() => { /* best-effort */ });
    }

    return assistantMsg;
  }
```

- [ ] **Step 4: Simplify the messages route to use `respond()`**

Replace the entire messages-route handler body (lines 79-134, the `fastify.post('/api/threads/:threadId/messages', …)` callback) with:

```ts
  fastify.post('/api/threads/:threadId/messages', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const body = request.body as { content: string; attachments?: string };
    // Persist the user's turn, then run the agent.
    insertMessage(threadId, 'user', body.content, body.attachments || '[]');
    return respond(threadId, body.content);
  });
```

- [ ] **Step 5: Typecheck**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 6: Run tests (no regressions)**

Run: `npm run --workspace=src/backend test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/routes/chat.ts
git commit -m "refactor(backend): extract respond() + persist question messages"
```

---

### Task 6: Chat route — the answer endpoint

**Files:**
- Modify: `src/backend/routes/chat.ts` (add route after the messages route)

- [ ] **Step 1: Add the `/answer` route**

In `src/backend/routes/chat.ts`, immediately after the messages-route handler (the `fastify.post('/api/threads/:threadId/messages', …)` block from Task 5), add:

```ts
  /**
   * Record the user's answer to a question card, then run the continuation turn.
   * The answer is stored both human-readably (content) and structured
   * (structured_json), and fed back to the agent as the next user turn.
   */
  fastify.post('/api/threads/:threadId/answer', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const body = request.body as { question_message_id: string; replies: Reply[] };

    const qRow = db.prepare('SELECT structured_json FROM chat_messages WHERE id = ?').get(body.question_message_id) as { structured_json: string | null } | undefined;
    if (!qRow || !qRow.structured_json) {
      return insertMessage(threadId, 'assistant', '[Error] Question not found.');
    }
    const ask = JSON.parse(qRow.structured_json) as Ask;
    const summary = buildAnswerSummary(ask, body.replies);

    // Persist the user's answer turn (human-readable summary + structured replies).
    const answerSet: AnswerSet = { replies: body.replies };
    insertMessage(threadId, 'user', summary, '[]', 'answer', JSON.stringify(answerSet));

    // Continuation turn — same path as a normal message.
    return respond(threadId, summary);
  });
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/backend/routes/chat.ts
git commit -m "feat(backend): POST /api/threads/:id/answer continuation route"
```

---

### Task 7: Frontend API method

**Files:**
- Modify: `src/frontend/src/api.ts` (Reply import; `chat` block 68-78)

- [ ] **Step 1: Import the `Reply` type**

Find the shared-types import near the top of `src/frontend/src/api.ts` (it already imports `ChatMessage`, `ChatThread`, etc.) and add `Reply` to it. For example, if the line reads `import { ..., ChatMessage, ChatThread } from '@nexus/shared';`, add `Reply`:

```ts
import { /* …existing… */ ChatMessage, ChatThread, Reply } from '@nexus/shared';
```

- [ ] **Step 2: Add `chat.answer`**

In the `chat` object, immediately after the `sendMessage` entry (line 75), add:

```ts
    // Submits the user's selection for a question card; backend runs the continuation turn.
    answer: (threadId: string, questionMessageId: string, replies: Reply[]) =>
      fetchJson<ChatMessage>(`${API}/threads/${threadId}/answer`, { method: 'POST', body: JSON.stringify({ question_message_id: questionMessageId, replies }) }),
```

- [ ] **Step 3: Typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: FAIL — `ChatPanel.tsx` optimistic message literal is missing the new fields (fixed in Task 9). The `api.ts` line itself must compile; if the error mentions `api.ts`, fix it before moving on.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/api.ts
git commit -m "feat(frontend): chat.answer api method"
```

---

### Task 8: QuestionCard component

**Files:**
- Create: `src/frontend/src/components/QuestionCard.tsx`

- [ ] **Step 1: Create the component**

Create `src/frontend/src/components/QuestionCard.tsx`:

```tsx
import { useState } from 'react';
import { Ask, Reply } from '@nexus/shared';
import { api } from '../api';

interface QuestionCardProps {
  ask: Ask;
  /** Text shown above the questions (the assistant's preamble). */
  preamble: string;
  threadId: string;
  questionMessageId: string;
  /** True once a later turn exists — render read-only. */
  answered: boolean;
  /** The user's recorded replies, when answered. */
  answeredReplies?: Reply[];
  /** Called after a successful submit so the parent can refetch the thread. */
  onAnswered: () => void;
}

const CARD = 'bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm space-y-3 max-w-[75%]';

export default function QuestionCard({ ask, preamble, threadId, questionMessageId, answered, answeredReplies, onAnswered }: QuestionCardProps) {
  const [selected, setSelected] = useState<string[][]>(ask.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(ask.questions.map(() => ''));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (qi: number, label: string, multiple: boolean) => {
    setSelected(prev => {
      const next = prev.map(a => [...a]);
      if (multiple) {
        const set = new Set(next[qi]);
        if (set.has(label)) set.delete(label); else set.add(label);
        next[qi] = [...set];
      } else {
        next[qi] = [label];
      }
      return next;
    });
  };

  const complete = ask.questions.every((_, i) => selected[i].length > 0 || custom[i].trim().length > 0);

  const submit = async () => {
    if (!complete || submitting) return;
    setSubmitting(true);
    const replies: Reply[] = ask.questions.map((q, i) => ({
      header: q.header,
      selected: selected[i],
      ...(custom[i].trim() ? { custom: custom[i].trim() } : {}),
    }));
    try {
      await api.chat.answer(threadId, questionMessageId, replies);
      onAnswered();
    } catch (err) {
      console.error('Failed to submit answer:', err);
      setSubmitting(false);
    }
  };

  // Read-only state after the question has been answered.
  if (answered) {
    return (
      <div className={`${CARD} text-zinc-300`}>
        {preamble && <p className="whitespace-pre-wrap">{preamble}</p>}
        {ask.questions.map((q, i) => {
          const chosen = answeredReplies?.[i];
          const picks = chosen ? [...chosen.selected, ...(chosen.custom ? [chosen.custom] : [])] : [];
          return (
            <div key={i} className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{q.header}</div>
              <div className="text-zinc-200">{q.question}</div>
              <div className="flex flex-wrap gap-1">
                {q.options.map(o => (
                  <span key={o.label} className={`text-xs px-2 py-0.5 rounded border ${picks.includes(o.label) ? 'bg-indigo-500/20 border-indigo-500 text-indigo-200' : 'border-zinc-700 text-zinc-500'}`}>{o.label}</span>
                ))}
                {chosen?.custom && (
                  <span className="text-xs px-2 py-0.5 rounded border bg-indigo-500/20 border-indigo-500 text-indigo-200">✎ {chosen.custom}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`${CARD} text-zinc-200`}>
      {preamble && <p className="whitespace-pre-wrap">{preamble}</p>}
      {ask.questions.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">{q.header}</div>
          <div className="text-zinc-100">{q.question}</div>
          <div className="space-y-1">
            {q.options.map(o => (
              <label key={o.label} className="flex items-start gap-2 cursor-pointer hover:bg-zinc-800/50 rounded px-2 py-1">
                <input
                  type={q.multiple ? 'checkbox' : 'radio'}
                  name={`q-${questionMessageId}-${qi}`}
                  checked={selected[qi].includes(o.label)}
                  onChange={() => toggle(qi, o.label, q.multiple)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-zinc-100">{o.label}</span>
                  {o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}
                </span>
              </label>
            ))}
            {q.custom && (
              <input
                type="text"
                value={custom[qi]}
                onChange={(e) => setCustom(prev => { const n = [...prev]; n[qi] = e.target.value; return n; })}
                placeholder="Type your own answer…"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 mt-1"
              />
            )}
          </div>
        </div>
      ))}
      <button
        onClick={submit}
        disabled={!complete || submitting}
        className="bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded px-3 py-1.5"
      >
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: FAIL only in `ChatPanel.tsx` (optimistic literal), not in `QuestionCard.tsx`. If the error names `QuestionCard.tsx`, fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/QuestionCard.tsx
git commit -m "feat(frontend): QuestionCard component (single/multi-select + free-text)"
```

---

### Task 9: ChatPanel render branch + optimistic-message fix

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx` (import; optimistic literal ~111; messages map 261-276)

- [ ] **Step 1: Import the types + component**

At the top of `src/frontend/src/components/ChatPanel.tsx`, add to the `@nexus/shared` import the `Ask` and `AnswerSet` types (alongside the existing `FileAttachment` import), and import the card:

```ts
import { Ask, AnswerSet } from '@nexus/shared';
import QuestionCard from './QuestionCard';
```

(If `FileAttachment` is imported from `@nexus/shared` on an existing line, add `Ask, AnswerSet` to that same import instead of adding a new line.)

- [ ] **Step 2: Fix the optimistic user-message literal**

In `handleSend`, the optimistic message (currently line 111) is missing the new required fields. Replace that array element with:

```tsx
      { id: `tmp-${Date.now()}`, thread_id: threadId!, role: 'user', content, attachments_json: attachmentsJson, message_type: 'text', structured_json: null, created_at: new Date().toISOString() },
```

- [ ] **Step 3: Add the question render branch**

Replace the messages `.map(...)` block (lines 261-276) with:

```tsx
              {messages.map((msg, idx) => {
                if (msg.message_type === 'question' && msg.structured_json) {
                  const ask = JSON.parse(msg.structured_json) as Ask;
                  // A question is open only while it is the last message in the thread.
                  const isLast = idx === messages.length - 1;
                  const nextMsg = messages[idx + 1];
                  const answeredReplies = nextMsg && nextMsg.message_type === 'answer' && nextMsg.structured_json
                    ? (JSON.parse(nextMsg.structured_json) as AnswerSet).replies
                    : undefined;
                  return (
                    <div key={msg.id} className="flex justify-start">
                      <QuestionCard
                        ask={ask}
                        preamble={msg.content}
                        threadId={activeThreadId!}
                        questionMessageId={msg.id}
                        answered={!isLast}
                        answeredReplies={answeredReplies}
                        onAnswered={() => loadMessages(activeThreadId!)}
                      />
                    </div>
                  );
                }
                return (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-lg px-4 py-2 text-sm ${msg.role === 'user' ? 'bg-indigo-500 text-white' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'}`}>
                      {msg.attachments_json && msg.attachments_json !== '[]' && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {JSON.parse(msg.attachments_json).map((a: FileAttachment, i: number) => (
                            <span key={i} className="text-xs bg-white/10 px-2 py-0.5 rounded truncate max-w-[200px]">
                              📎 {a.original_name}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                );
              })}
```

- [ ] **Step 4: Typecheck the whole frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS (the optimistic-literal error from Tasks 7-8 is now resolved).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/ChatPanel.tsx
git commit -m "feat(frontend): render QuestionCard for question messages"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + build all workspaces**

Run: `npm run typecheck && npm run build`
Expected: PASS across `src/shared`, `src/backend`, `src/frontend`, `electron`, and the daemon build.

- [ ] **Step 2: Run backend tests**

Run: `npm run --workspace=src/backend test`
Expected: PASS — cron, providers, `ask`, and `db` suites all green.

- [ ] **Step 3: Migration smoke-test on a copy of the real DB**

Run (requires `npm run build` from Step 1 so `dist/db.js` exists):

```bash
cp ~/.nexus/nexus.db /tmp/nexus-mig-check.db
node -e "const {getDb}=require('./src/backend/dist/db.js'); const d=getDb('/tmp/nexus-mig-check.db'); console.log(d.pragma('table_info(chat_messages)').map(c=>c.name).join(',')); d.close();"
rm -f /tmp/nexus-mig-check.db*
```

Expected: the printed column list includes `message_type` and `structured_json`, proving the guarded ALTER runs cleanly against a pre-existing DB (not just a fresh one).

- [ ] **Step 4: Manual end-to-end (live app)**

Start the stack (`npm run web`) and, in a chat thread whose persona is reachable:
1. Send a message that should make the agent ask (e.g. "Set up a database for me but ask me which one first").
2. Confirm a **QuestionCard** renders with radio options + a "Type your own answer" field.
3. Select an option and **Submit** → confirm a user "answer" bubble appears with the summary text, and the agent produces a follow-up turn.
4. Confirm the answered card is now **read-only** with the chosen option highlighted.
5. Send another prompt asking for a multi-select question (`multiple: true`) → confirm checkboxes, select two, submit → both recorded.
6. Free-text path: answer via the "Type your own answer" field → confirm it appears in the summary.

Expected: all six behave as described; no console errors.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore: interactive question messages verification fixes"
```

---

## Self-Review notes

- **Spec coverage:** message model + migration (Tasks 1-2), emit convention injection (Task 4), `parseAskBlock` tolerant parser incl. `<ask_user>` fallback + defaults (Task 3), question persistence + answer route + continuation turn (Tasks 5-6), QuestionCard with single/multi/custom + locked state (Task 8), render branch (Task 9), api method (Task 7), tests for parser + summary + migration (Tasks 2-3), edge cases (malformed→null, missing options→null, Unanswered) covered in Task 3 tests. All spec sections map to a task.
- **Type consistency:** `Ask`/`Question`/`QuestionOption`/`Reply`/`AnswerSet` defined once in Task 1 and used verbatim everywhere; `parseAskBlock` returns `{ preamble, ask }`; `insertMessage(threadId, role, content, attachments, messageType, structuredJson)` signature is consistent across Tasks 5-6; `chat.answer(threadId, questionMessageId, replies)` matches the route body `{ question_message_id, replies }`.
- **Known non-TDD areas (intentional):** the `/answer` route and ChatPanel rendering are verified manually (Task 10) because the repo has no HTTP/React test harness and adding one is out of scope; the pure logic they depend on (`parseAskBlock`, `buildAnswerSummary`, migration) is unit-tested.
