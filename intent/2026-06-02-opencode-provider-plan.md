# OpenCode Provider + Per-Engine Model Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode as a CLI provider kind and give every persona a curated, per-provider model dropdown (Claude/Codex subscription models; OpenCode's OpenRouter contingency models behind a dedicated view).

**Architecture:** A persona = engine (provider) + model. Each `Provider` row carries a curated `models: string[]` list plus optional OpenCode `args`. Dispatch adds an `opencode` case that spawns `opencode run --model <model> [args] <prompt>` via the existing `runCli`. The frontend turns the persona Model field into a dropdown sourced from the chosen provider's models, and adds a dedicated "OpenCode Models" view.

**Tech Stack:** TypeScript monorepo — `src/shared` (types), `src/backend` (Fastify + better-sqlite3), `src/frontend` (React + Vite + Tailwind + Phosphor icons). Tests: `node:test` via `tsx --test` (pure functions only).

**Spec:** `project_docs/specs/2026-06-02-opencode-provider-design.md`

**Conventions:** This plan is versioned in `intent/`; the spec lives in Dropbox `project_docs/specs/` (git-ignored, never staged). Commit code changes per task. Run all commands from the repo root `/Users/k-sym/Projects/nexus`.

---

### Task 1: Shared types — add `opencode` kind + `models`/`args` fields

**Files:**
- Modify: `src/shared/index.ts:91-103`

- [ ] **Step 1: Add `opencode` to `ProviderKind` and the two new `Provider` fields**

In `src/shared/index.ts`, change the `ProviderKind` line:

```ts
export type ProviderKind = 'claude_code' | 'codex' | 'opencode' | 'openai_compat';
```

Then add two fields to the `Provider` interface (after `default_model`, before `created_at`):

```ts
export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** openai_compat only — base URL incl. /v1 (OpenRouter, omlx, LM Studio, llama.cpp…). */
  base_url: string | null;
  /** openai_compat only — bearer token; supports ${ENV_VAR} interpolation. */
  api_key: string | null;
  /** optional default model for this provider. */
  default_model: string | null;
  /** curated list of model identifiers this provider offers (shown in the persona dropdown). */
  models: string[];
  /** optional free-form CLI launch flags — OpenCode only (e.g. "--agent build"). */
  args: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Rebuild shared so downstream typechecks see the new shape**

Run: `npm run --workspace=src/shared build`
Expected: `tsc` completes, no output errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): add opencode ProviderKind + Provider.models/args"
```

(Note: `src/shared/dist` is gitignored — never `git add` it. Downstream typechecks consume the rebuilt `dist` locally without it being tracked.)

---

### Task 2: Database — migrate `providers` with `models` + `args`

**Files:**
- Modify: `src/backend/db.ts:104-112` (CREATE TABLE) and `:170-174` (after the agent_runs migration loop)

- [ ] **Step 1: Add the two columns to the `CREATE TABLE` (fresh DBs)**

In `src/backend/db.ts`, update the providers table definition:

```sql
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      default_model TEXT,
      models TEXT DEFAULT '[]',
      args TEXT,
      created_at TEXT NOT NULL
    );
```

- [ ] **Step 2: Add a guarded migration for existing DBs**

In `src/backend/db.ts`, immediately AFTER the `runMigrations` loop (the block ending at the `}` on line ~174), add:

```ts
  // Provider curated-models + args migrations (for DBs created before this feature).
  const provCols = db.pragma('table_info(providers)') as { name: string }[];
  const provColNames = new Set(provCols.map(c => c.name));
  const provMigrations: Array<[string, string]> = [
    ['models', "ALTER TABLE providers ADD COLUMN models TEXT DEFAULT '[]'"],
    ['args', 'ALTER TABLE providers ADD COLUMN args TEXT'],
  ];
  for (const [col, sql] of provMigrations) {
    if (!provColNames.has(col)) {
      db.exec(sql);
    }
  }
```

- [ ] **Step 3: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/backend/db.ts
git commit -m "feat(backend): add providers.models + providers.args columns + migration"
```

---

### Task 3: Dispatch — `runOpenCode` + pure arg-builders (TDD)

**Files:**
- Modify: `src/backend/orchestrator/providers.ts` (add helpers + `runOpenCode` + `runPersona` case)
- Test: `src/backend/test/providers.test.ts` (new)

- [ ] **Step 1: Write the failing test for the pure arg-builders**

Create `src/backend/test/providers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs, buildOpenCodeArgs } from '../orchestrator/providers';

test('splitArgs splits on whitespace and drops empties', () => {
  assert.deepEqual(splitArgs('--agent build  --foo'), ['--agent', 'build', '--foo']);
  assert.deepEqual(splitArgs('--model=openrouter/x'), ['--model=openrouter/x']);
});

test('splitArgs tolerates null/empty', () => {
  assert.deepEqual(splitArgs(null), []);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('   '), []);
});

test('buildOpenCodeArgs runs with model + extra args before the prompt', () => {
  assert.deepEqual(
    buildOpenCodeArgs('openrouter/anthropic/claude-sonnet-4.5', '--agent build', 'hello world'),
    ['run', '--model', 'openrouter/anthropic/claude-sonnet-4.5', '--agent', 'build', 'hello world'],
  );
});

test('buildOpenCodeArgs omits --model when no model is given', () => {
  assert.deepEqual(buildOpenCodeArgs('', null, 'hi'), ['run', 'hi']);
  assert.deepEqual(buildOpenCodeArgs(undefined, undefined, 'hi'), ['run', 'hi']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=src/backend test`
Expected: FAIL — `splitArgs`/`buildOpenCodeArgs` are not exported from `../orchestrator/providers`.

- [ ] **Step 3: Implement the pure helpers**

In `src/backend/orchestrator/providers.ts`, add these exports near the top (after `estimateTokens`, before `TIMEOUT_MS`):

```ts
/** Split a free-form CLI args string into argv. v1: whitespace split (no quote handling). */
export function splitArgs(s: string | null | undefined): string[] {
  return (s ?? '').trim().split(/\s+/).filter(Boolean);
}

/** Build argv for `opencode run`: model flag (if any), then extra args, then the prompt. */
export function buildOpenCodeArgs(
  model: string | null | undefined,
  args: string | null | undefined,
  prompt: string,
): string[] {
  return ['run', ...(model ? ['--model', model] : []), ...splitArgs(args), prompt];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace=src/backend test`
Expected: PASS (all 4 new tests, plus existing cron tests).

- [ ] **Step 5: Add `runOpenCode` and the `runPersona` dispatch case**

In `src/backend/orchestrator/providers.ts`, add `runOpenCode` right after `runCodex` (before the `OpenAICompatibleOptions` interface):

```ts
export function runOpenCode(
  workspace: string,
  prompt: string,
  onOutput: StreamCallback,
  model?: string,
  extraArgs?: string | null,
): Promise<ProviderResult> {
  // A bare `opencode` opens the interactive TUI; `run` is required for headless one-shot.
  // OpenCode uses its OWN provider credentials (e.g. OpenRouter) — Nexus just invokes the CLI.
  const args = buildOpenCodeArgs(model, extraArgs, prompt);
  return runCli('opencode', args, workspace, prompt, onOutput);
}
```

Then in `runPersona`, inside the `if (provider) { switch (provider.kind) {` block, add a case after `case 'codex':` (before `case 'openai_compat':`):

```ts
      case 'opencode':
        return runOpenCode(workspace, withSystem, onOutput, model, provider.args);
```

(`model` is already computed at the top of that block as `persona.model || provider.default_model || ''`.)

- [ ] **Step 6: Typecheck the backend (partial — known pre-existing errors)**

Run: `npm run --workspace=src/backend typecheck`
Expected: errors remain **only** in `routes/providers.ts` (those are fixed in Task 4). Confirm your changes to `orchestrator/providers.ts` introduce **no new** errors in that file or elsewhere. The whole-backend typecheck goes fully green after Task 4.

- [ ] **Step 7: Commit**

```bash
git add src/backend/orchestrator/providers.ts src/backend/test/providers.test.ts
git commit -m "feat(backend): opencode dispatch (runOpenCode) + arg-builders with tests"
```

---

### Task 4: Provider routes — persist + serve `models`/`args`, seed OpenCode

**Files:**
- Modify: `src/backend/routes/providers.ts`

- [ ] **Step 1: Import `ProviderKind` and widen `COLS`**

Change the import on line 13:

```ts
import { Provider, ProviderKind } from '@nexus/shared';
```

Change `COLS` (line 16):

```ts
const COLS = 'id, name, kind, base_url, api_key, default_model, models, args, created_at';
```

- [ ] **Step 2: Add a row→Provider parser (models stored as JSON)**

In `src/backend/routes/providers.ts`, add right after the `COLS` constant:

```ts
/** DB rows store `models` as a JSON string; parse it back into string[] for the API. */
function rowToProvider(row: any): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url ?? null,
    api_key: row.api_key ?? null,
    default_model: row.default_model ?? null,
    models: row.models ? JSON.parse(row.models) : [],
    args: row.args ?? null,
    created_at: row.created_at,
  };
}
```

- [ ] **Step 3: Update `seedProviders` to seed models + an OpenCode provider**

Replace the `seed` array and insert loop inside `seedProviders` (lines ~29-36) with:

```ts
  const seed = [
    { id: 'seed-openrouter', name: 'OpenRouter', kind: 'openai_compat', base_url: 'https://openrouter.ai/api/v1', api_key: config.models.openrouter.api_key || null, default_model: 'anthropic/claude-sonnet-4', models: JSON.stringify([]), args: null, created_at: now },
    { id: 'seed-local', name: 'Local (omlx)', kind: 'openai_compat', base_url: config.models.local.base_url || 'http://127.0.0.1:4001/v1', api_key: config.models.local.api_key || null, default_model: null, models: JSON.stringify([]), args: null, created_at: now },
    { id: 'seed-claude-code', name: 'Claude Code', kind: 'claude_code', base_url: null, api_key: null, default_model: 'sonnet', models: JSON.stringify(['opus', 'sonnet', 'haiku']), args: null, created_at: now },
    { id: 'seed-codex', name: 'Codex', kind: 'codex', base_url: null, api_key: null, default_model: null, models: JSON.stringify(['gpt-5.5', 'gpt-5.3-codex']), args: null, created_at: now },
    { id: 'seed-opencode', name: 'OpenCode', kind: 'opencode', base_url: null, api_key: null, default_model: null, models: JSON.stringify(['openrouter/anthropic/claude-sonnet-4.5']), args: null, created_at: now },
  ];
  for (const p of seed) ins.run(p);
  console.log(`[providers] seeded ${seed.length} default providers`);
```

(The `ins` prepare statement already uses `${COLS}`, so it now binds `@models` and `@args` automatically.)

- [ ] **Step 4: Accept `opencode` + persist `models`/`args` in POST**

Replace the POST handler body (lines ~82-95) with:

```ts
  fastify.post('/api/providers', async (request) => {
    const b = request.body as Partial<Provider>;
    const kind: ProviderKind =
      b.kind === 'claude_code' || b.kind === 'codex' || b.kind === 'opencode' ? b.kind : 'openai_compat';
    const row = {
      id: uuid(),
      name: b.name?.trim() || 'Unnamed provider',
      kind,
      base_url: b.base_url?.trim() || null,
      api_key: b.api_key?.trim() || null,
      default_model: b.default_model?.trim() || null,
      models: JSON.stringify(Array.isArray(b.models) ? b.models : []),
      args: (b.args ?? '').trim() || null,
      created_at: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO providers (${COLS}) VALUES (@id, @name, @kind, @base_url, @api_key, @default_model, @models, @args, @created_at)`).run(row);
    return rowToProvider(row);
  });
```

- [ ] **Step 5: Persist `models`/`args` in PUT**

Replace the PUT handler body (lines ~97-112) with:

```ts
  fastify.put('/api/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as any;
    if (!existing) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    const b = request.body as Partial<Provider>;
    const row = {
      id,
      name: b.name?.trim() || existing.name,
      kind: b.kind ?? existing.kind,
      base_url: b.base_url !== undefined ? b.base_url || null : existing.base_url,
      api_key: b.api_key !== undefined ? b.api_key || null : existing.api_key,
      default_model: b.default_model !== undefined ? b.default_model || null : existing.default_model,
      models: b.models !== undefined ? JSON.stringify(Array.isArray(b.models) ? b.models : []) : existing.models,
      args: b.args !== undefined ? (b.args || null) : existing.args,
      created_at: existing.created_at,
    };
    db.prepare('UPDATE providers SET name=@name, kind=@kind, base_url=@base_url, api_key=@api_key, default_model=@default_model, models=@models, args=@args WHERE id=@id').run(row);
    return rowToProvider(row);
  });
```

- [ ] **Step 6: Parse rows in GET list + the `/test` lookup, and handle `opencode` in `testProvider`**

Change the GET list handler (line ~80) to parse rows:

```ts
  fastify.get('/api/providers', async () => (db.prepare(`SELECT ${COLS} FROM providers ORDER BY name ASC`).all() as any[]).map(rowToProvider));
```

Change the `/test` lookup (line ~122) to check existence first, then parse:

```ts
    const row = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as any;
    if (!row) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    return testProvider(rowToProvider(row));
```

In `testProvider`, change the CLI command resolution (line ~58) to cover opencode:

```ts
  const command = p.kind === 'claude_code' ? config.claude_code.command
    : p.kind === 'codex' ? config.codex.command
    : 'opencode';
```

- [ ] **Step 7: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/backend/routes/providers.ts
git commit -m "feat(backend): providers persist models/args, seed OpenCode, accept opencode kind"
```

---

### Task 5: Mission Control status probe — recognize `opencode` as a CLI

**Files:**
- Modify: `src/backend/routes/status.ts:80`

- [ ] **Step 1: Add `opencode` to the CLI-kind branch**

Change line 80 from:

```ts
  } else if (kind === 'claude_code' || kind === 'codex') {
```

to:

```ts
  } else if (kind === 'claude_code' || kind === 'codex' || kind === 'opencode') {
```

- [ ] **Step 2: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/backend/routes/status.ts
git commit -m "feat(backend): treat opencode as a CLI kind in the status probe"
```

---

### Task 6: ProvidersSettings — OpenCode kind, Models textarea, Arguments field

**Files:**
- Modify: `src/frontend/src/components/ProvidersSettings.tsx`

- [ ] **Step 1: Add the OpenCode kind option**

Change the `KINDS` array (lines 6-10):

```ts
const KINDS: { value: ProviderKind; label: string }[] = [
  { value: 'openai_compat', label: 'OpenAI-compatible (OpenRouter / local / omlx)' },
  { value: 'claude_code', label: 'Claude Code (CLI)' },
  { value: 'codex', label: 'Codex (CLI)' },
  { value: 'opencode', label: 'OpenCode (CLI)' },
];
```

- [ ] **Step 2: Add Models (claude/codex) + Arguments (opencode) fields to the editor**

In the editor form, immediately AFTER the `default_model` input (the `<input>` ending at line ~128, before the `<div className="flex gap-2">` save/cancel row), insert:

```tsx
          {(editing.kind === 'claude_code' || editing.kind === 'codex') && (
            <textarea
              value={(editing.models ?? []).join('\n')}
              onChange={e => setEditing({ ...editing, models: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              placeholder={'Models (one per line)\nopus\nsonnet\nhaiku'}
              rows={3}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 resize-none"
            />
          )}
          {editing.kind === 'opencode' && (
            <>
              <div className="text-[11px] text-zinc-500">Models for OpenCode are curated in the <span className="text-zinc-300">OpenCode Models</span> view.</div>
              <input
                value={editing.args ?? ''}
                onChange={e => setEditing({ ...editing, args: e.target.value })}
                placeholder="Extra CLI args (optional, e.g. --agent build)"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
              />
            </>
          )}
```

- [ ] **Step 3: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/ProvidersSettings.tsx
git commit -m "feat(frontend): OpenCode kind + per-provider models/args in ProvidersSettings"
```

---

### Task 7: PersonaEditor — model dropdown from the provider's curated list

**Files:**
- Modify: `src/frontend/src/components/PersonaEditor.tsx`

- [ ] **Step 1: Add custom-model state + reset model on provider change**

Add a state hook after the existing `model` state (line 28):

```ts
  const [customModel, setCustomModel] = useState(false);
```

Replace `onProviderChange` (line 65) with one that resets the model when switching providers:

```ts
  const onProviderChange = (id: string) => { setProviderId(id); setModel(''); setCustomModel(false); };
```

- [ ] **Step 2: Replace the free-text Model input with a dropdown + custom escape hatch**

Replace the Model `<div>` block (lines 137-147 — the `<label>Model</label>` through its closing `</div>`) with:

```tsx
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Model</label>
              {customModel || (selectedProvider?.models?.length ?? 0) === 0 ? (
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={selectedProvider?.default_model ? `${selectedProvider.default_model} (provider default)` : 'model id'}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
                />
              ) : (
                <select
                  value={model}
                  onChange={e => { if (e.target.value === '__custom__') { setCustomModel(true); setModel(''); } else setModel(e.target.value); }}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="">Provider default{selectedProvider?.default_model ? ` (${selectedProvider.default_model})` : ''}</option>
                  {selectedProvider!.models.map(m => <option key={m} value={m}>{m}</option>)}
                  <option value="__custom__">Custom…</option>
                </select>
              )}
              <p className="text-[10px] text-zinc-600 mt-1">Leave on “Provider default” to track the provider's model live.</p>
            </div>
```

- [ ] **Step 3: Remove the now-redundant default-model auto-fill**

The provider-load effect sets `setModel(prev => prev || list[0]?.default_model || '')` (line 51). Change it so a new persona starts on "Provider default" (blank) rather than snapshotting a model:

```ts
      // Leave model blank for new personas → "use provider default" (no snapshot).
```

(Delete the `setModel(prev => prev || list[0]?.default_model || '');` line entirely. For an existing persona, `model` is already initialized from `initial?.model` in `useState`.)

- [ ] **Step 4: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/PersonaEditor.tsx
git commit -m "feat(frontend): persona Model becomes a provider-sourced dropdown"
```

---

### Task 8: Dedicated "OpenCode Models" view + nav wiring

**Files:**
- Create: `src/frontend/src/components/OpenCodeModelsView.tsx`
- Modify: `src/frontend/src/components/Sidebar.tsx` (Self group), `src/frontend/src/App.tsx` (View type, GLOBAL_VIEWS, renderMain, palette)

- [ ] **Step 1: Create the OpenCode Models view component**

Create `src/frontend/src/components/OpenCodeModelsView.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Provider } from '@nexus/shared';
import { api } from '../api';
import { Plus, Trash, Stack } from '@phosphor-icons/react';

export default function OpenCodeModelsView() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const list = await api.providers.list();
    const oc = list.find(p => p.kind === 'opencode') ?? null;
    setProvider(oc);
    setModels(oc?.models ?? []);
  }, []);
  useEffect(() => { load().catch(console.error); }, [load]);

  const persist = async (next: string[]) => {
    if (!provider) return;
    setModels(next);
    await api.providers.update(provider.id, { models: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const add = () => {
    const v = draft.trim();
    if (!v || models.includes(v)) { setDraft(''); return; }
    persist([...models, v]); setDraft('');
  };
  const remove = (m: string) => persist(models.filter(x => x !== m));

  if (!provider) {
    return (
      <div className="flex-1 p-6">
        <div className="text-sm text-zinc-500">No OpenCode provider found. Add one in <span className="text-zinc-300">Settings → Providers</span> (kind “OpenCode”).</div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-xl">
        <div className="flex items-center gap-2 mb-1">
          <Stack size={18} className="text-indigo-400" />
          <h1 className="text-base font-semibold text-zinc-100">OpenCode Models</h1>
          {saved && <span className="text-[11px] text-emerald-400">saved</span>}
        </div>
        <p className="text-xs text-zinc-500 mb-4">Curated OpenCode model strings (e.g. <span className="font-mono text-zinc-400">openrouter/anthropic/claude-sonnet-4.5</span>). Selectable when a persona uses the OpenCode provider.</p>

        <div className="flex gap-2 mb-3">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(); }}
            placeholder="openrouter/anthropic/claude-sonnet-4.5"
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          <button onClick={add} className="flex items-center gap-1 px-3 py-2 text-sm bg-indigo-500 text-white rounded hover:bg-indigo-600"><Plus size={14} /> Add</button>
        </div>

        <div className="space-y-1.5">
          {models.map(m => (
            <div key={m} className="flex items-center gap-3 bg-zinc-950 border border-zinc-800 rounded px-3 py-2">
              <span className="flex-1 text-sm font-mono text-zinc-200 truncate">{m}</span>
              <button onClick={() => remove(m)} title="Remove" className="text-zinc-600 hover:text-red-400"><Trash size={15} /></button>
            </div>
          ))}
          {models.length === 0 && <div className="text-xs text-zinc-600">No models yet — add one above.</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the nav entry in the Self group**

In `src/frontend/src/components/Sidebar.tsx`, update the icon import (line 4) to include `Stack`:

```ts
import { Kanban, ChatCircle, Brain, Clock, ChartBar, UsersThree, Gear, Stack, type Icon } from '@phosphor-icons/react';
```

Then in the Self group, add an item between Personas and Settings (after line 109):

```tsx
      <NavItem active={view === 'opencode-models'} onClick={() => onSelectView('opencode-models')} icon={<Stack size={16} />}>
        OpenCode Models
      </NavItem>
```

- [ ] **Step 3: Register the view in App.tsx**

In `src/frontend/src/App.tsx`:

(a) Add the import near the other component imports (after line 16):

```ts
import OpenCodeModelsView from './components/OpenCodeModelsView';
```

(b) Add `'opencode-models'` to the `View` union (after `'settings'`, line 27):

```ts
  | 'settings'
  | 'opencode-models'
```

(c) Add it to `GLOBAL_VIEWS` (line 35):

```ts
const GLOBAL_VIEWS = ['mission-control', 'tickets', 'personas', 'settings', 'opencode-models'];
```

(d) Render it in `renderMain` (after the `settings` line, line 204):

```tsx
    if (view === 'opencode-models') return <OpenCodeModelsView />;
```

(e) Add a command-palette entry (after the `act-settings` push, line 195):

```ts
    cmds.push({ id: 'act-opencode-models', label: 'OpenCode Models', hint: 'Action', keywords: 'opencode openrouter models', run: () => setView('opencode-models') });
```

- [ ] **Step 4: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/OpenCodeModelsView.tsx src/frontend/src/components/Sidebar.tsx src/frontend/src/App.tsx
git commit -m "feat(frontend): dedicated OpenCode Models view + nav/palette wiring"
```

---

### Task 9: Full verification — build, tests, manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Backend tests pass**

Run: `npm run --workspace=src/backend test`
Expected: PASS (cron + the 4 new providers tests).

- [ ] **Step 2: Whole-repo typecheck**

Run: `npm run typecheck`
Expected: PASS for shared, backend, frontend.

- [ ] **Step 3: Whole-repo build (incl. daemon)**

Run: `npm run build`
Expected: all workspaces + daemon build with no errors.

- [ ] **Step 4: Manual smoke (dev)**

Run: `npm run web` (boots daemon + backend + frontend, opens the browser).

Verify each:
- Settings → Providers shows an **OpenCode (CLI)** provider; editing it shows the **Arguments** field and the "curated in the OpenCode Models view" hint (no Models textarea). Editing **Claude Code** shows a **Models** textarea with `opus/sonnet/haiku`.
- The **OpenCode Models** nav entry (Self group) opens the view; add a model string → it persists across reload (`PUT /api/providers/:id`).
- Create a persona on the **OpenCode** provider → the **Model** field is a dropdown of the curated models + "Provider default" + "Custom…". Repeat on **Claude Code** (opus/sonnet/haiku).
- Mission Control shows the OpenCode agent with a status dot (CLI → `ready`).
- (If `opencode` is installed + authed) Provider → **Test** returns the `opencode --version` line; chatting to an OpenCode persona spawns `opencode run --model <chosen> [args] <prompt>` and returns a reply.

- [ ] **Step 5: Final commit (if any docs/cleanup touched)**

```bash
git status   # confirm clean; commit anything outstanding
```

---

## Self-review notes (author)

- **Spec coverage:** §1 types→T1; §2 storage→T2; §3 routes/seed/test→T4; §4 dispatch→T3; §5 dedicated view→T8; §6 PersonaEditor→T7; §7 ProvidersSettings→T6; §8 status probe→T5. All covered.
- **Out-of-scope honored:** OpenRouter chat provider left intact; no OpenRouter key/connection added; single OpenCode provider assumed; no `--model` reverse-parse for display.
- **Type consistency:** `splitArgs`/`buildOpenCodeArgs`/`runOpenCode` signatures match between Task 3 definition and usage; `models: string[]` + `args: string | null` consistent across shared type, DB (JSON TEXT), routes (`rowToProvider`), and frontend.
