# Navigation Redesign + Persona Identity — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip Nexus navigation so projects form a collapsible left-hand tree (Kanban / Memory / Chat-accordion-of-threads), move global + management links to the top bar, and give personas an icon + accent colour that prefixes and tints chat-thread rows.

**Architecture:** Persona `icon`/`color` are new optional fields on the YAML-parsed `PersonaConfig`; the backend already parses persona config server-side and will expose the two fields on the personas + status payloads (no DB migration). The frontend left `Sidebar` is rewritten as a project tree, `TopBar` is rewritten to hold globals + the management group, `App` moves to an `{activeProjectId, subView, activeThreadId}` state model (retiring the `agent:${slug}` room), and `ChatPanel` slims to a `threadId`-driven active-thread renderer because the thread list now lives in the tree.

**Tech Stack:** React + TypeScript + Tailwind (frontend, no test runner — verify via `typecheck`/build/manual), Fastify + better-sqlite3 + js-yaml (backend, `node:test` via `tsx --test`), `@phosphor-icons/react` (already a dependency).

**Phase boundary:** This plan is navigation + persona identity only. The embedded terminal (PTY, xterm, `chat_threads.mode`, terminal-mode in the new-chat picker) is **Phase 2**, a separate plan. The new-chat picker built here selects persona only; threads default to chat mode.

---

## File Structure

**Modify**
- `src/shared/index.ts` — add `icon?`/`color?` to `PersonaConfig`; add `PERSONA_ICON_NAMES` + `DEFAULT_PERSONA_COLOR`; extend the personas/status payload shape with parsed `icon`/`color`.
- `src/backend/routes/status.ts` — include parsed `icon`/`color` in the agent payload.
- `src/backend/routes/personas.ts` — include parsed `icon`/`color` in the personas list payload; round-trip them through save.
- `src/frontend/src/api.ts` — type the new `icon`/`color` fields on the persona/agent responses.
- `src/frontend/src/components/Sidebar.tsx` — rewritten as the project tree.
- `src/frontend/src/components/TopBar.tsx` — rewritten: globals left, management group right; project tabs removed.
- `src/frontend/src/App.tsx` — new `{activeProjectId, subView, activeThreadId}` state model; remove `agent:${slug}` view + `AgentRoom`; wire the tree + new-chat picker.
- `src/frontend/src/components/ChatPanel.tsx` — drop the internal thread-list sidebar + "New chats use:" dropdown; become `threadId`-driven.
- `src/frontend/src/components/PersonaEditor.tsx` — add icon + colour picker.

**Create**
- `src/frontend/src/personaIcons.tsx` — curated icon-name → Phosphor component map + `PersonaIcon` render helper.
- `src/frontend/src/components/NewChatPicker.tsx` — persona-selection popover for `+ New`.
- `src/backend/test/persona-visual.test.ts` — tests for the persona-visual parse helper.
- `src/backend/persona-visual.ts` — pure helper deriving `{icon, color}` from `config_yaml` with defaults.

---

## Task 1: Persona visual fields in shared types

**Files:**
- Modify: `src/shared/index.ts` (PersonaConfig interface ~line 168; add new exports near it)

- [ ] **Step 1: Add `icon`/`color` to `PersonaConfig` and curated constants**

In `src/shared/index.ts`, add to the `PersonaConfig` interface (alongside `system_prompt`):

```ts
  /** Phosphor icon name from PERSONA_ICON_NAMES; identifies the persona at a glance. */
  icon?: string;
  /** Accent colour (hex, e.g. "#f59e0b") for the icon and thread-row tint. */
  color?: string;
```

Then add, immediately after the `PersonaConfig` interface:

```ts
/** Curated Phosphor icon names offered for personas (name→component map lives in the frontend). */
export const PERSONA_ICON_NAMES = [
  'Wrench', 'Code', 'MagnifyingGlass', 'Compass', 'PaintBrush',
  'Brain', 'Lightning', 'Robot', 'Detective', 'Sparkle',
] as const;
export type PersonaIconName = typeof PERSONA_ICON_NAMES[number];

/** Default accent when a persona has no colour set. */
export const DEFAULT_PERSONA_COLOR = '#a1a1aa'; // zinc-400
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run --workspace=src/shared typecheck`
Expected: PASS (no output / exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): add icon/color to PersonaConfig + curated icon names"
```

---

## Task 2: Backend persona-visual parse helper (TDD)

A pure helper that reads a persona's `config_yaml` and returns `{ icon, color }` with safe defaults, reused by the personas + status routes.

**Files:**
- Create: `src/backend/persona-visual.ts`
- Test: `src/backend/test/persona-visual.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/persona-visual.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonaVisual } from '../persona-visual';
import { DEFAULT_PERSONA_COLOR } from '@nexus/shared';

test('parses icon and color from config_yaml', () => {
  const yaml = 'name: Dev\nslug: dev\nicon: Wrench\ncolor: "#f59e0b"\n';
  assert.deepEqual(parsePersonaVisual(yaml), { icon: 'Wrench', color: '#f59e0b' });
});

test('falls back to undefined icon and default color when absent', () => {
  const yaml = 'name: Dev\nslug: dev\n';
  assert.deepEqual(parsePersonaVisual(yaml), { icon: undefined, color: DEFAULT_PERSONA_COLOR });
});

test('returns defaults on malformed yaml', () => {
  assert.deepEqual(parsePersonaVisual(':::not yaml:::'), { icon: undefined, color: DEFAULT_PERSONA_COLOR });
});

test('ignores a non-string icon', () => {
  const yaml = 'icon: 42\ncolor: "#fff"\n';
  assert.deepEqual(parsePersonaVisual(yaml), { icon: undefined, color: '#fff' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=src/backend test`
Expected: FAIL — `Cannot find module '../persona-visual'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/backend/persona-visual.ts`:

```ts
import yaml from 'js-yaml';
import { DEFAULT_PERSONA_COLOR } from '@nexus/shared';

export interface PersonaVisual {
  icon: string | undefined;
  color: string;
}

/** Derive a persona's visual identity (icon name + accent colour) from its config_yaml. */
export function parsePersonaVisual(configYaml: string): PersonaVisual {
  let cfg: { icon?: unknown; color?: unknown } = {};
  try {
    cfg = (yaml.load(configYaml) as typeof cfg) ?? {};
  } catch {
    /* malformed yaml — fall through to defaults */
  }
  return {
    icon: typeof cfg.icon === 'string' ? cfg.icon : undefined,
    color: typeof cfg.color === 'string' ? cfg.color : DEFAULT_PERSONA_COLOR,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=src/backend test`
Expected: PASS — all four `persona-visual` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backend/persona-visual.ts src/backend/test/persona-visual.test.ts
git commit -m "feat(backend): persona-visual parse helper with defaults + tests"
```

---

## Task 3: Expose icon/color on personas + status payloads

**Files:**
- Modify: `src/backend/routes/personas.ts` (list endpoint)
- Modify: `src/backend/routes/status.ts:66` (agent payload)
- Modify: `src/frontend/src/api.ts` (response types)

- [ ] **Step 1: Add icon/color to the personas list response**

In `src/backend/routes/personas.ts`, import the helper at the top:

```ts
import { parsePersonaVisual } from '../persona-visual';
```

Find the GET handler that returns the personas list (selects `id, name, slug, config_yaml`). Map each row to include the parsed visual fields, e.g.:

```ts
const rows = db.prepare('SELECT id, name, slug, config_yaml, created_at FROM personas').all() as Persona[];
return rows.map(p => ({ ...p, ...parsePersonaVisual(p.config_yaml) }));
```

- [ ] **Step 2: Add icon/color to the status agent payload**

In `src/backend/routes/status.ts`, where each persona's `config_yaml` is already parsed (around line 66, the `c = yaml.load(...)` block), add the persona's `icon`/`color` to the agent object it builds. Reuse the helper:

```ts
import { parsePersonaVisual } from '../persona-visual';
// …when building each agent entry:
const visual = parsePersonaVisual(p.config_yaml);
// include in the returned agent object:
//   icon: visual.icon, color: visual.color,
```

- [ ] **Step 3: Type the fields on the frontend API**

In `src/frontend/src/api.ts`, extend the `AgentStatus`/`AgentHealth` persona-bearing type and the personas list return type with:

```ts
  icon?: string;
  color: string;
```

(Find `AgentStatus` and the `api.personas.list` return type; add both fields. `color` is always present — the backend defaults it.)

- [ ] **Step 4: Verify backend + frontend typecheck**

Run: `npm run --workspace=src/backend typecheck && npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/personas.ts src/backend/routes/status.ts src/frontend/src/api.ts
git commit -m "feat: expose persona icon/color on personas + status payloads"
```

---

## Task 4: Frontend persona icon map + render helper

**Files:**
- Create: `src/frontend/src/personaIcons.tsx`

- [ ] **Step 1: Create the icon map and `PersonaIcon` component**

Create `src/frontend/src/personaIcons.tsx`:

```tsx
import {
  Wrench, Code, MagnifyingGlass, Compass, PaintBrush,
  Brain, Lightning, Robot, Detective, Sparkle, type Icon,
} from '@phosphor-icons/react';
import { DEFAULT_PERSONA_COLOR, PERSONA_ICON_NAMES, type PersonaIconName } from '@nexus/shared';

const ICONS: Record<PersonaIconName, Icon> = {
  Wrench, Code, MagnifyingGlass, Compass, PaintBrush,
  Brain, Lightning, Robot, Detective, Sparkle,
};

/** The curated choices, for the persona editor picker. */
export const PERSONA_ICON_CHOICES = PERSONA_ICON_NAMES.map(name => ({ name, Icon: ICONS[name] }));

/** Render a persona's icon in its accent colour; falls back to Robot/zinc when unset/unknown. */
export function PersonaIcon({ icon, color, size = 16 }: { icon?: string; color?: string; size?: number }) {
  const Cmp = (icon && ICONS[icon as PersonaIconName]) || Robot;
  return <Cmp size={size} weight="fill" color={color || DEFAULT_PERSONA_COLOR} />;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/personaIcons.tsx
git commit -m "feat(frontend): persona icon map + PersonaIcon render helper"
```

---

## Task 5: Persona editor icon + colour picker

**Files:**
- Modify: `src/frontend/src/components/PersonaEditor.tsx`

- [ ] **Step 1: Add the picker UI**

In `PersonaEditor.tsx`, the editor edits the persona's parsed config (or its `config_yaml`). Add two controls that read/write `config.icon` and `config.color`:

```tsx
import { PERSONA_ICON_CHOICES, PersonaIcon } from '../personaIcons';
import { DEFAULT_PERSONA_COLOR } from '@nexus/shared';

// …inside the form, after the name/system_prompt fields:
<div className="space-y-2">
  <label className="text-xs uppercase tracking-wider text-zinc-500">Icon</label>
  <div className="flex flex-wrap gap-1.5">
    {PERSONA_ICON_CHOICES.map(({ name, Icon }) => (
      <button
        key={name}
        type="button"
        onClick={() => setConfig(c => ({ ...c, icon: name }))}
        className={`p-2 rounded-md border transition-colors ${config.icon === name ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-800 hover:border-zinc-600'}`}
        title={name}
      >
        <Icon size={18} weight="fill" color={config.color || DEFAULT_PERSONA_COLOR} />
      </button>
    ))}
  </div>
  <label className="text-xs uppercase tracking-wider text-zinc-500">Accent colour</label>
  <input
    type="color"
    value={config.color || DEFAULT_PERSONA_COLOR}
    onChange={e => setConfig(c => ({ ...c, color: e.target.value }))}
    className="h-8 w-16 bg-transparent border border-zinc-800 rounded"
  />
  <div className="flex items-center gap-2 text-sm text-zinc-400">
    Preview: <PersonaIcon icon={config.icon} color={config.color} size={20} /> {config.name || 'Persona'}
  </div>
</div>
```

Adapt `setConfig`/`config` to the editor's actual state variable names. When the editor serialises back to `config_yaml` (js-yaml `dump`), `icon`/`color` ride along automatically because they're now part of the config object.

- [ ] **Step 2: Verify typecheck + manual round-trip**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.
Manual: `npm run dev`, open a persona, pick an icon + colour, save, reopen — selection persists (round-trips through `config_yaml`).

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/PersonaEditor.tsx
git commit -m "feat(frontend): persona editor icon + colour picker"
```

---

## Task 6: New-chat picker component

A small popover anchored to `+ New` under a project's Chat: pick a persona (shown with icon), then start. (Mode toggle is Phase 2; this returns mode `'chat'`.)

**Files:**
- Create: `src/frontend/src/components/NewChatPicker.tsx`

- [ ] **Step 1: Create the component**

Create `src/frontend/src/components/NewChatPicker.tsx`:

```tsx
import { useState } from 'react';
import { PersonaIcon } from '../personaIcons';

export interface PersonaChoice { slug: string; name: string; icon?: string; color: string; }

export default function NewChatPicker({
  personas, onStart, onClose,
}: {
  personas: PersonaChoice[];
  onStart: (slug: string) => void;   // Phase 2 will widen to (slug, mode)
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(personas[0]?.slug ?? '');
  if (personas.length === 0) {
    return <div className="p-3 text-xs text-zinc-500">No personas yet — create one under Agents.</div>;
  }
  return (
    <div className="w-60 rounded-lg border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">New chat — pick a persona</div>
      <div className="max-h-56 overflow-y-auto">
        {personas.map(p => (
          <button
            key={p.slug}
            onClick={() => setSelected(p.slug)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${selected === p.slug ? 'bg-indigo-500/20 text-white' : 'text-zinc-400 hover:bg-zinc-800/40'}`}
          >
            <PersonaIcon icon={p.icon} color={p.color} />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button onClick={() => onStart(selected)} className="px-3 py-1 text-xs bg-indigo-500 text-ink rounded-md hover:bg-indigo-600">Start</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/NewChatPicker.tsx
git commit -m "feat(frontend): NewChatPicker persona-selection popover"
```

---

## Task 7: Rewrite TopBar (globals left, management right)

**Files:**
- Modify: `src/frontend/src/components/TopBar.tsx` (full rewrite)
- Modify: `src/frontend/src/App.tsx` (TopBar props — completed in Task 9)

- [ ] **Step 1: Replace TopBar with the globals/management layout**

Replace the contents of `src/frontend/src/components/TopBar.tsx`:

```tsx
import { Gauge, Ticket, Clock, ChartBar, UsersThree, Stack, Gear } from '@phosphor-icons/react';

export type GlobalView = 'dashboard' | 'tickets' | 'scheduler' | 'usage';
export type ManageView = 'personas' | 'opencode-models' | 'settings';

interface TopBarProps {
  view: string;
  onSelectGlobal: (v: GlobalView) => void;
  onSelectManage: (v: ManageView) => void;
  onOpenPalette: () => void;
}

const item = (active: boolean) =>
  `shrink-0 flex items-center gap-1.5 px-3 py-1 text-sm rounded-md transition-colors whitespace-nowrap ${
    active ? 'bg-indigo-500 text-ink' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'
  }`;

export default function TopBar({ view, onSelectGlobal, onSelectManage, onOpenPalette }: TopBarProps) {
  return (
    <header className="h-12 shrink-0 flex items-center gap-1.5 px-3 border-b border-zinc-800 bg-zinc-900">
      <div className="flex items-center gap-2 pr-1">
        <div className="w-6 h-6 rounded bg-indigo-500 flex items-center justify-center text-ink text-[11px] font-bold">N</div>
        <span className="font-semibold text-sm tracking-wide hidden md:inline">NEXUS</span>
      </div>
      <button onClick={onOpenPalette} title="Command palette" className="shrink-0 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors">⌘K</button>
      <div className="w-px h-5 bg-zinc-800 mx-1 shrink-0" />

      {/* Global / cross-project links */}
      <button onClick={() => onSelectGlobal('dashboard')} className={item(view === 'dashboard')}><Gauge size={16} weight={view === 'dashboard' ? 'fill' : 'regular'} /> Dashboard</button>
      <button onClick={() => onSelectGlobal('tickets')} className={item(view === 'tickets')}><Ticket size={16} weight={view === 'tickets' ? 'fill' : 'regular'} /> Tickets</button>
      <button onClick={() => onSelectGlobal('scheduler')} className={item(view === 'scheduler')}><Clock size={16} weight={view === 'scheduler' ? 'fill' : 'regular'} /> Scheduler</button>
      <button onClick={() => onSelectGlobal('usage')} className={item(view === 'usage')}><ChartBar size={16} weight={view === 'usage' ? 'fill' : 'regular'} /> Usage</button>

      {/* Management group, right-aligned */}
      <div className="ml-auto flex items-center gap-1.5">
        <button onClick={() => onSelectManage('personas')} className={item(view === 'personas')}><UsersThree size={16} /> Agents</button>
        <button onClick={() => onSelectManage('opencode-models')} className={item(view === 'opencode-models')}><Stack size={16} /> Models</button>
        <button onClick={() => onSelectManage('settings')} className={item(view === 'settings')}><Gear size={16} /> Settings</button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: FAIL — `App.tsx` still passes the old TopBar props. This is expected; Task 9 fixes the call site. (If running tasks out of order, do Task 9 before typechecking the whole app.)

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/TopBar.tsx
git commit -m "feat(frontend): rewrite TopBar with global + management links"
```

---

## Task 8: Rewrite Sidebar as the project tree

`Scheduler`/`Usage` are removed from per-project nav (they're in the top bar now). Each project expands to Kanban, Memory, and a Chat accordion of threads.

**Files:**
- Modify: `src/frontend/src/components/Sidebar.tsx` (full rewrite)

- [ ] **Step 1: Replace Sidebar with the tree**

Replace the contents of `src/frontend/src/components/Sidebar.tsx`:

```tsx
import { useState } from 'react';
import { Project, ChatThread } from '@nexus/shared';
import { CaretRight, CaretDown, Kanban, Brain, ChatCircle, Plus } from '@phosphor-icons/react';
import { PersonaIcon } from '../personaIcons';

export type SubView = 'kanban' | 'memory' | 'chat';

export interface ThreadMeta {
  thread: ChatThread;
  icon?: string;
  color: string;
}

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  subView: SubView;
  activeThreadId: string | null;
  /** threads for the active project, keyed for the open Chat accordion (with persona visuals resolved) */
  threads: ThreadMeta[];
  onSelectProject: (id: string) => void;
  onSelectSubView: (projectId: string, sub: SubView) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onNewChat: (projectId: string, anchor: HTMLElement) => void;
  onNewProject: () => void;
}

function Row({ active, depth, onClick, icon, children, tintColor, trailing }: {
  active: boolean; depth: number; onClick: () => void; icon?: React.ReactNode;
  children: React.ReactNode; tintColor?: string; trailing?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{ paddingLeft: 8 + depth * 14, borderLeft: tintColor ? `2px solid ${tintColor}` : '2px solid transparent' }}
      className={`group w-full flex items-center gap-2 pr-2 py-1.5 text-sm transition-colors ${
        active ? 'bg-indigo-500/20 text-white' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/30'
      }`}
    >
      {icon && <span className="shrink-0 flex items-center w-4">{icon}</span>}
      <span className="truncate flex-1 text-left">{children}</span>
      {trailing}
    </button>
  );
}

export default function Sidebar({
  projects, activeProjectId, subView, activeThreadId, threads,
  onSelectProject, onSelectSubView, onSelectThread, onNewChat, onNewProject,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string) => expanded[id] ?? (id === activeProjectId);

  return (
    <aside className="w-60 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0 overflow-y-auto">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Projects</span>
        <button onClick={onNewProject} title="New project" className="text-zinc-500 hover:text-zinc-200"><Plus size={14} /></button>
      </div>

      {projects.map(project => {
        const open = isExpanded(project.id);
        const isActiveProject = project.id === activeProjectId;
        const chatExpanded = chatOpen[project.id] ?? false;
        return (
          <div key={project.id}>
            <Row
              active={isActiveProject && false}
              depth={0}
              onClick={() => { setExpanded(e => ({ ...e, [project.id]: !open })); onSelectProject(project.id); }}
              icon={open ? <CaretDown size={14} /> : <CaretRight size={14} />}
            >
              <span className="font-medium text-zinc-200 truncate">{project.name}</span>
            </Row>

            {open && (
              <>
                <Row active={isActiveProject && subView === 'kanban'} depth={1} onClick={() => onSelectSubView(project.id, 'kanban')} icon={<Kanban size={15} />}>Kanban</Row>
                <Row active={isActiveProject && subView === 'memory'} depth={1} onClick={() => onSelectSubView(project.id, 'memory')} icon={<Brain size={15} />}>Memory</Row>
                <Row
                  active={isActiveProject && subView === 'chat' && !activeThreadId}
                  depth={1}
                  onClick={() => { setChatOpen(c => ({ ...c, [project.id]: !chatExpanded })); onSelectSubView(project.id, 'chat'); }}
                  icon={<ChatCircle size={15} />}
                  trailing={chatExpanded ? <CaretDown size={12} className="text-zinc-600" /> : <CaretRight size={12} className="text-zinc-600" />}
                >
                  Chat
                </Row>

                {chatExpanded && (
                  <>
                    <Row
                      active={false}
                      depth={2}
                      onClick={(e => {}) as never}
                      icon={<Plus size={14} />}
                    >
                      <span
                        onClick={ev => { ev.stopPropagation(); onNewChat(project.id, ev.currentTarget.parentElement as HTMLElement); }}
                        className="text-indigo-400"
                      >
                        New
                      </span>
                    </Row>
                    {isActiveProject && threads.map(({ thread, icon, color }) => (
                      <Row
                        key={thread.id}
                        active={activeThreadId === thread.id}
                        depth={2}
                        tintColor={color}
                        onClick={() => onSelectThread(project.id, thread.id)}
                        icon={<PersonaIcon icon={icon} color={color} size={14} />}
                      >
                        {thread.title}
                      </Row>
                    ))}
                    {isActiveProject && threads.length === 0 && (
                      <div className="pl-12 py-1.5 text-xs text-zinc-600">No conversations</div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
      {projects.length === 0 && <div className="px-3 py-2 text-xs text-zinc-600">No projects yet</div>}

      <div className="mt-auto px-3 py-3 border-t border-zinc-800">
        <div className="text-[10px] text-zinc-600/50">v0.1.0 · Personal</div>
      </div>
    </aside>
  );
}
```

> Note: the `+ New` row uses a nested span click so the popover can anchor to that element; `onNewChat` receives the anchor for positioning the `NewChatPicker`. Adjust anchoring to your popover approach if you prefer a fixed-position modal — the contract is just `(projectId, anchorEl)`.

- [ ] **Step 2: Verify typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: FAIL until `App.tsx` (Task 9) provides the new props. Expected at this stage.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): rewrite Sidebar as collapsible project tree"
```

---

## Task 9: App state model — wire tree, top bar, new-chat picker

Move `App` from the `View` union (with `agent:${slug}`) to `{ activeProjectId, subView, activeThreadId }` for project-scoped work plus a `globalView` for top-bar destinations. Retire `AgentRoom`.

**Files:**
- Modify: `src/frontend/src/App.tsx`

- [ ] **Step 1: Replace the view/state model**

In `src/App.tsx`:

1. Remove the `import AgentRoom` line and the `agent:${string}` arm of the `View` type.
2. Replace the view state with:

```tsx
type GlobalView = 'dashboard' | 'tickets' | 'scheduler' | 'usage' | 'personas' | 'opencode-models' | 'settings';
type SubView = 'kanban' | 'memory' | 'chat';

const [globalView, setGlobalView] = useState<GlobalView | null>('dashboard'); // null = a project is focused
const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
const [subView, setSubView] = useState<SubView>('kanban');
const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
const [threads, setThreads] = useState<ChatThread[]>([]);
const [newChat, setNewChat] = useState<{ projectId: string } | null>(null);
```

3. Add thread loading for the active project (the tree owns the list now):

```tsx
const loadThreads = useCallback(async (projectId: string) => {
  try { setThreads(await api.chat.threads(projectId)); }
  catch (err) { console.error('Failed to load threads:', err); }
}, []);

useEffect(() => { if (activeProjectId) loadThreads(activeProjectId); else setThreads([]); }, [activeProjectId, loadThreads]);
```

4. Build `ThreadMeta[]` resolving persona visuals from `status?.agents` (which now carry `icon`/`color` from Task 3):

```tsx
const threadMetas = useMemo(() => threads.map(t => {
  const agent = status?.agents.find(a => a.slug === t.agent_id);
  return { thread: t, icon: agent?.icon, color: agent?.color ?? DEFAULT_PERSONA_COLOR };
}), [threads, status]);
```

(Import `DEFAULT_PERSONA_COLOR` from `@nexus/shared`.)

- [ ] **Step 2: Wire navigation handlers**

```tsx
const selectGlobal = (v: GlobalView) => { setGlobalView(v); setActiveThreadId(null); };
const focusProject = (id: string) => { setGlobalView(null); setActiveProjectId(id); };
const selectSubView = (projectId: string, sub: SubView) => { setGlobalView(null); setActiveProjectId(projectId); setSubView(sub); if (sub !== 'chat') setActiveThreadId(null); };
const selectThread = (projectId: string, threadId: string) => { setGlobalView(null); setActiveProjectId(projectId); setSubView('chat'); setActiveThreadId(threadId); };

const startNewChat = async (slug: string) => {
  if (!newChat) return;
  const thread = await api.chat.createThread(newChat.projectId, slug);
  setNewChat(null);
  await loadThreads(newChat.projectId);
  selectThread(newChat.projectId, thread.id);
};
```

- [ ] **Step 3: Replace TopBar + Sidebar usage and `renderMain`**

Update the JSX:

```tsx
<TopBar
  view={globalView ?? ''}
  onSelectGlobal={selectGlobal}
  onSelectManage={selectGlobal}
  onOpenPalette={() => setPaletteOpen(true)}
/>
<div className="flex flex-1 min-h-0">
  <Sidebar
    projects={projects}
    activeProjectId={activeProjectId}
    subView={subView}
    activeThreadId={activeThreadId}
    threads={activeProjectId ? threadMetas : []}
    onSelectProject={focusProject}
    onSelectSubView={selectSubView}
    onSelectThread={selectThread}
    onNewChat={(projectId) => setNewChat({ projectId })}
    onNewProject={() => setShowProjectModal(true)}
  />
  <main className="flex-1 flex flex-col min-w-0">{renderMain()}</main>
</div>
{newChat && (
  <div className="fixed inset-0 z-40" onClick={() => setNewChat(null)}>
    <div className="absolute left-60 top-24" onClick={e => e.stopPropagation()}>
      <NewChatPicker
        personas={(status?.agents ?? []).map(a => ({ slug: a.slug, name: a.name, icon: a.icon, color: a.color }))}
        onStart={startNewChat}
        onClose={() => setNewChat(null)}
      />
    </div>
  </div>
)}
```

Rewrite `renderMain` to branch on `globalView` first (dashboard/tickets/scheduler/usage/personas/opencode-models/settings), then fall through to project-scoped rendering using `subView`:

```tsx
const renderMain = () => {
  if (globalView === 'personas') return <PersonasPage />;
  if (globalView === 'settings') return <SettingsPage />;
  if (globalView === 'opencode-models') return <OpenCodeModelsView />;
  if (globalView === 'dashboard') return <MissionControl status={status} loading={statusLoading} onRefresh={loadStatus} onSelectAgent={() => {}} />;
  if (globalView === 'tickets') return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;
  if (!activeProject) return (/* keep the existing "No project selected" empty state */);

  // project-scoped header (keep existing markup), then:
  if (subView === 'kanban') return /* existing KanbanBoard block + ColumnAgentMapping footer */;
  if (subView === 'memory') return <MemoryView projectId={activeProject.id} />;
  if (subView === 'chat') return <ChatPanel projectId={activeProject.id} threadId={activeThreadId} onThreadsChanged={() => loadThreads(activeProject.id)} agents={status?.agents} />;
  return null;
};
```

> Scheduler/Usage now render via `globalView`. Add `if (globalView === 'scheduler') return <SchedulerPage />;` and `if (globalView === 'usage') return <UsagePage />;` — **note** these components currently take a `projectId` prop ([App.tsx:273-276](../src/frontend/src/App.tsx)). Per the spec they are global now: update `SchedulerPage`/`UsagePage` to drop the required `projectId` (or make it optional and aggregate across projects). If that widening is non-trivial, capture it as a follow-up task rather than blocking this one.

- [ ] **Step 4: Remove dead command-palette entries**

In the `commands` `useMemo`, remove the `agent:${slug}` command entries (the `personas.forEach(... goToView(\`agent:${p.slug}\`))` line) and any `goToView` references to removed views. Point view commands at `selectGlobal`/`selectSubView` as appropriate.

- [ ] **Step 5: Verify the whole frontend typechecks + builds**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS (after Tasks 7, 8, 10 are also applied — TopBar, Sidebar, ChatPanel signatures all align here).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/App.tsx
git commit -m "feat(frontend): project-tree state model; retire AgentRoom view"
```

---

## Task 10: Slim ChatPanel to a threadId-driven renderer

The thread list + "New chats use:" dropdown move to the tree; `ChatPanel` renders only the active thread.

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx`

- [ ] **Step 1: Change the props and drop the internal sidebar**

Replace the `ChatPanelProps` and the internal thread-state with a `threadId`-driven model:

```tsx
interface ChatPanelProps {
  projectId: string;
  threadId: string | null;
  agents?: AgentStatus[];
  /** called after rename/delete so the tree (source of truth) reloads */
  onThreadsChanged?: () => void;
}
```

Changes:
1. Delete the left thread-list `<div className="w-52 …">` block (current lines ~254-310) and the outer `flex` wrapper that paired it with the chat area — `ChatPanel` now returns just the chat area.
2. Remove `threads`, `activeThreadId` local state, `loadThreads`, `handleNewThread`, rename/delete handlers, and the `selectedAgent`/`agentSlug` dropdown (lines ~317-341). Drive everything from the `threadId` prop:

```tsx
const activeThreadId = threadId;
useEffect(() => { if (threadId) loadMessages(threadId); else setMessages([]); }, [threadId, loadMessages]);
```

3. After a successful send that captures a session id or changes the title, call `onThreadsChanged?.()` so the tree refreshes (replace the old `loadThreads()` calls).
4. Keep the messages list, composer, attachments, question cards, and the resume chip (incl. the existing osascript "Open terminal" button — retained per spec).
5. For the agent label/header, resolve the persona from `agents` by the loaded thread's `agent_id` (the thread object comes from `api.chat.messages` context; if needed, fetch the single thread or pass its `agent_id` down — simplest is to look it up from a `threads` prop, but to avoid re-introducing the list, resolve via the first message's thread or accept a small `agentSlug` prop from `App`). Choose the lookup that keeps `ChatPanel` list-free.

- [ ] **Step 2: Verify typecheck + manual**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.
Manual: `npm run dev` → expand a project → Chat → New → pick persona → Start; thread opens, sends/receives, appears in the tree with the persona icon + colour tint; rename/delete from the tree (Task 8/9 wiring) reflects in the panel.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/ChatPanel.tsx
git commit -m "refactor(frontend): ChatPanel is threadId-driven; thread list lives in tree"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Backend tests + typecheck**

Run: `npm --workspace=src/backend test && npm run --workspace=src/backend typecheck`
Expected: PASS, including the four `persona-visual` tests.

- [ ] **Step 2: Frontend typecheck + build**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.

- [ ] **Step 3: Manual smoke (dev)**

Run: `npm run dev`. Verify:
- Top bar shows Dashboard / Tickets / Scheduler / Usage on the left; Agents / Models / Settings on the right; no project tabs.
- Left tree lists projects; expanding shows Kanban, Memory, Chat; Chat expands to `+ New` + threads.
- Threads show persona icon + accent-colour left-border tint.
- New chat: `+ New` → persona popover → Start → thread opens in the main area.
- Persona editor: icon + colour picker persists across save/reopen.
- Scheduler and Usage open from the top bar (global).
- No remaining "agent room" navigation; command palette has no `agent:` entries.

- [ ] **Step 4: Final commit (if any stragglers)**

```bash
git add -A && git commit -m "chore: phase-1 navigation redesign verification fixes"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** project tree (T8), Kanban/Memory direct + Chat accordion (T8), top-bar globals + management (T7), Scheduler/Usage moved global (T9 step 3 + flagged `projectId` widening), persona icon/color in `config_yaml` + no DB migration (T1–T3), icon-prefixed + colour-tinted rows (T4/T8), new-chat persona picker (T6/T9), `AgentRoom` retired (T9), `ChatPanel` slimmed (T10). Terminal/`mode` intentionally **deferred to Phase 2**.
- **Known follow-up:** `SchedulerPage`/`UsagePage` currently require `projectId`; making them global may need a small prop change or aggregation — flagged in T9 step 3.
- **Out-of-order edits:** Tasks 7, 8, 10 each leave the app non-compiling until Task 9 aligns call sites; run the full-app typecheck only after T9, or execute T7→T8→T10→T9 as a unit.
