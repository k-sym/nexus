# Project Memory Rail (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a thin, collapsible read-only memory rail on the right of the Chat/Terminal area, showing a project's recent memories with one-line quick-add and a link to the full Memory page.

**Architecture:** A self-contained `MemoryRail` component reusing the existing memory API (`api.memory.list` / `api.memory.create`); rendered as a fixed-width sibling beside the chat/terminal content in `App.renderMain`'s `subView === 'chat'` branch. Collapse state persists in `localStorage`; the list polls every 15s while open. No backend, route, DB, or shared-type changes.

**Tech Stack:** React + TypeScript + Tailwind, `@phosphor-icons/react` (all already in use). Frontend has no test runner — verify via `typecheck` + `build` + manual.

**Builds on:** Phases 1–2 (merged). The chat branch already routes terminal threads to `TerminalPane` and others to `ChatPanel`; `selectSubView(projectId, 'memory')` already navigates to the full Memory page.

---

## File Structure

**Create**
- `src/frontend/src/components/MemoryRail.tsx` — the rail (recent list + quick-add + collapse + poll).

**Modify**
- `src/frontend/src/App.tsx` — render `<MemoryRail>` beside the content in the `subView === 'chat'` branch.

No other files. No backend/shared changes.

---

## Task 1: Create the `MemoryRail` component

**Files:**
- Create: `src/frontend/src/components/MemoryRail.tsx`

- [ ] **Step 1: Write the component**

Create `src/frontend/src/components/MemoryRail.tsx` with exactly this content:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { CaretRight, CaretLeft, ArrowSquareOut } from '@phosphor-icons/react';
import { api } from '../api';

interface MemoryRailProps {
  projectId: string;
  /** Navigate to the full Memory page for this project. */
  onOpenFull: () => void;
}

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  created_at: string;
}

const STORAGE_KEY = 'nexus.memoryRail.open';
const POLL_MS = 15_000;
const RECENT_LIMIT = 15;

export default function MemoryRail({ projectId, onOpenFull }: MemoryRailProps) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== 'false'; } catch { return true; }
  });
  const [recent, setRecent] = useState<MemoryRow[]>([]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(open)); } catch { /* ignore */ }
  }, [open]);

  const load = useCallback(async () => {
    try {
      const rows = await api.memory.list(projectId);
      setRecent((rows as MemoryRow[]).slice(0, RECENT_LIMIT));
    } catch {
      /* keep last list on error */
    }
  }, [projectId]);

  // Load on project change + poll while open. No polling while collapsed.
  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [open, load]);

  const handleAdd = async () => {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      await api.memory.create(projectId, { content, category: 'general' });
      setDraft('');
      await load();
    } catch (err) {
      console.error('Failed to add memory:', err);
    } finally {
      setAdding(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(); }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Show memory"
        className="shrink-0 w-8 border-l border-zinc-800 bg-zinc-900/50 flex flex-col items-center justify-center gap-2 text-zinc-500 hover:text-zinc-200 transition-colors"
      >
        <CaretLeft size={16} />
        <span className="text-[10px] uppercase tracking-wider [writing-mode:vertical-rl]">Memory</span>
      </button>
    );
  }

  return (
    <aside className="shrink-0 w-72 border-l border-zinc-800 bg-zinc-900/50 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Memory</span>
        <div className="flex items-center gap-2">
          <button onClick={onOpenFull} title="Open full Memory page" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200 transition-colors">
            <ArrowSquareOut size={14} /> Open
          </button>
          <button onClick={() => setOpen(false)} title="Collapse" className="text-zinc-500 hover:text-zinc-200 transition-colors">
            <CaretRight size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {recent.length === 0 && (
          <div className="text-xs text-zinc-600 text-center py-6">No memories yet.</div>
        )}
        {recent.map(m => (
          <div key={m.id} className="bg-zinc-900 border border-zinc-800 rounded-md px-2.5 py-2" title={m.content}>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider text-indigo-400/80">{m.category}</span>
              {m.created_at && <span className="text-[10px] text-zinc-600">{m.created_at.slice(0, 10)}</span>}
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3 break-words">{m.content}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-800 p-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a memory… (Enter to save)"
          rows={2}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-indigo-500/50"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !draft.trim()}
          className="mt-1 w-full px-2 py-1 text-xs bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors"
        >
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Verify it typechecks and builds**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.

Notes for the implementer if a check fails:
- If `api.memory.list` / `api.memory.create` have different names/signatures than assumed, open `src/frontend/src/api.ts` and match `MemoryView`'s usage (it calls `api.memory.list(projectId)` and `api.memory.create(projectId, { content, category })`).
- `line-clamp-3` needs Tailwind ≥3.3 (built-in) or the line-clamp plugin. If the build/typecheck is fine but the clamp doesn't render, it's cosmetic — leave it; the `title={m.content}` still shows full text on hover. Do NOT add a Tailwind plugin for this.
- `CaretRight`, `CaretLeft`, `ArrowSquareOut` are valid `@phosphor-icons/react` exports; if any is missing in the installed version, substitute the closest valid icon and note it.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/MemoryRail.tsx
git commit -m "feat(frontend): MemoryRail component (recent + quick-add + collapse)"
```
End the commit message with a trailing line:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## Task 2: Render the rail in the Chat/Terminal branch

**Files:**
- Modify: `src/frontend/src/App.tsx`

- [ ] **Step 1: Import the component**

Add near the other component imports in `src/frontend/src/App.tsx`:

```tsx
import MemoryRail from './components/MemoryRail';
```

- [ ] **Step 2: Wrap the chat-branch content with the rail**

In `renderMain`, the `subView === 'chat'` branch currently resolves the active thread and returns either `<TerminalPane …/>` (terminal mode) or `<ChatPanel …/>`. Wrap whichever content it returns in a horizontal flex row with the rail beside it. The branch should end up equivalent to:

```tsx
if (subView === 'chat') {
  const active = threads.find(t => t.id === activeThreadId);
  const content = active?.mode === 'terminal'
    ? <TerminalPane key={active.id} threadId={active.id} />
    : <ChatPanel
        projectId={activeProject.id}
        threadId={activeThreadId}
        agentSlug={active?.agent_id}
        onThreadsChanged={() => loadThreads(activeProject.id)}
        agents={status?.agents}
      />;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0">{content}</div>
      <MemoryRail projectId={activeProject.id} onOpenFull={() => selectSubView(activeProject.id, 'memory')} />
    </div>
  );
}
```

IMPORTANT — adapt, don't blindly paste: read the ACTUAL current chat branch first (Phase 2 left it as an IIFE inside a JSX ternary). Preserve the exact `ChatPanel`/`TerminalPane` props already in use there (e.g. `agentSlug`, `onThreadsChanged`, `agents`, `key`) — only change the *wrapping* so the existing content sits in `<div className="flex-1 min-w-0">` next to `<MemoryRail/>`. Confirm `selectSubView` and `activeProject` are in scope in `renderMain` (they are — `selectSubView(projectId, sub)` is the tree's sub-view navigator, and `activeProject` is already used in this branch).

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/App.tsx
git commit -m "feat(frontend): mount MemoryRail beside Chat/Terminal"
```
End the commit message with a trailing line:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## Task 3: End-to-end verification (manual)

- [ ] **Step 1: Typecheck + build**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.

- [ ] **Step 2: Manual smoke (dev)**

Run `npm run dev`. Verify:
- Open a project → Chat: the memory rail appears on the right; recent memories render (category chip + date + snippet), or "No memories yet."
- Open a Terminal thread: the rail also appears beside the terminal.
- Switch to **Kanban** and the **Memory** page and a **global** view (Dashboard): the rail is **absent**.
- Quick-add: type a note, press Enter → it persists, appears at/near the top of the rail, and is visible on the full Memory page (category `general`).
- "Open" link → navigates to the full Memory page for the project.
- Collapse chevron → rail shrinks to a slim "Memory" reopen strip; reopen restores it. Reload the app → collapsed/open state is remembered.
- (Optional) Trigger an agent memory capture in a chat → it appears in the rail within ~15s (poll).

- [ ] **Step 3: Final commit (if any stragglers)**

```bash
git add -A && git commit -m "chore: phase-3 memory rail verification fixes"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** read-only recent peek (T1), one-line quick-add fixed `general` (T1), "Open" link to full page (T1+T2), collapsible with localStorage persistence default-open (T1), poll-while-open 15s + reload on project change/after add (T1), Chat+Terminal only via the chat branch (T2), no backend/shared changes (none in file list). Out-of-scope items (search/delete/edit/category in rail, Kanban/global, extensible container) are intentionally absent.
- **No new types/APIs:** reuses `api.memory.list`/`api.memory.create`; `MemoryRow` is a local interface mirroring `MemoryView`.
- **Known cosmetic dependency:** `line-clamp-3` relies on Tailwind ≥3.3; if absent it degrades gracefully (full text still on hover). Not worth a plugin.
```
