# Pi Thinking Options Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Spec: [`project_docs/specs/2026-07-24-pi-thinking-options-design.md`](../design/2026-07-24-pi-thinking-options-design.md)

**Goal:** Expose Pi thinking levels on the desktop chat composer, sticky per thread, applied on each send via `session.setThinkingLevel()`.

**Architecture:** Catalog enrichment (`thinkingLevels`) + optional `thinkingLevel` on stream POST + composer dropdown. No new endpoints. Glasses out of scope.

**Tech Stack:** Fastify backend, React/Vite frontend, `@earendil-works/pi-ai` (`getSupportedThinkingLevels`, `clampThinkingLevel`), `@earendil-works/pi-coding-agent` `AgentSession.setThinkingLevel`.

## Global Constraints

- Thinking levels are Pi ids only: `off | minimal | low | medium | high | xhigh | max`
- Do not invent a “Plan” mode
- Desktop `ChatPanel` only; Glasses deferred
- Per-thread in-memory stickiness; default `off`; no localStorage/DB
- Invalid `thinkingLevel` → 400; unsupported model → ignore, still send
- Match existing `ModelSelector` visual language (compact border button + portal menu)

## File map

| File | Role |
|------|------|
| `src/shared/...` or `src/frontend/src/lib/thinking.ts` + backend mirror | Shared level type, order, clamp-nearest, labels (prefer small duplicated constants if shared package wiring is heavy; otherwise put helpers in both with identical values — prefer one shared module if `@nexus/shared` already exports UI-agnostic types) |
| `src/backend/pi/model-curation.ts` | Add `thinkingLevels?` to `ModelCatalogItem` |
| `src/backend/routes/pi.ts` | Populate `thinkingLevels` in `buildModelCatalog` |
| `src/backend/routes/chat.ts` | Accept + apply `thinkingLevel`; extend `ChatSession` pick |
| `src/backend/test/pi-runtime.test.ts` | Catalog test |
| `src/backend/test/routes-chat.test.ts` | Stream thinkingLevel tests |
| `src/frontend/src/hooks/useModels.ts` | `thinkingLevels?` on `ModelInfo` |
| `src/frontend/src/hooks/usePiStream.ts` | Pass `thinkingLevel` in body |
| `src/frontend/src/lib/thinking.ts` | Level constants + `clampToSupportedThinkingLevel` |
| `src/frontend/src/components/ThinkingSelector.tsx` | New dropdown |
| `src/frontend/src/components/ChatPanel.tsx` | Wire state + UI |
| `src/frontend/src/components/ThinkingSelector.test.tsx` | Unit tests |
| `src/frontend/src/components/ChatPanel.test.tsx` | Integration tests |

---

### Task 1: Thinking level helpers (frontend)

**Files:**
- Create: `src/frontend/src/lib/thinking.ts`
- Create: `src/frontend/src/lib/thinking.test.ts`

**Produces:**
- `export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`
- `export const THINKING_LEVEL_ORDER: ThinkingLevel[]`
- `export const THINKING_LEVEL_SET: ReadonlySet<string>`
- `export function isThinkingLevel(value: unknown): value is ThinkingLevel`
- `export function thinkingLevelLabel(level: ThinkingLevel): string` — Off, Minimal, Low, Medium, High, XHigh, Max
- `export function clampToSupportedThinkingLevel(desired: ThinkingLevel, supported: ThinkingLevel[]): ThinkingLevel | undefined` — prefer closest ≤ desired; else lowest; undefined if `supported` empty

- [ ] **Step 1: Write failing tests** in `thinking.test.ts` (vitest) covering label, isThinkingLevel, clamp (exact match, lower neighbor, only higher available, empty list)

- [ ] **Step 2: Implement `thinking.ts`**

- [ ] **Step 3: Run** `npm run --workspace=src/frontend test -- src/lib/thinking.test.ts` — expect PASS

---

### Task 2: Catalog exposes `thinkingLevels`

**Files:**
- Modify: `src/backend/pi/model-curation.ts` — add `thinkingLevels?: ThinkingLevel[]` (inline the union type or import from a tiny backend helper)
- Modify: `src/backend/routes/pi.ts` — import `getSupportedThinkingLevels` from `@earendil-works/pi-ai`; map each model
- Modify: `src/backend/test/pi-runtime.test.ts` — assert catalog field present (mock model with `reasoning` / call real helper if model shape is enough)

**Backend helper (optional small file):** `src/backend/pi/thinking.ts` with `isThinkingLevel` + `THINKING_LEVELS` array for validation in chat route (keep identical to frontend union).

- [ ] **Step 1: Failing test** — `buildModelCatalog` includes `thinkingLevels` as an array (can stub `getSupportedThinkingLevels` by using a fake model object that the real helper accepts, or assert `Array.isArray` on result when registry returns models; if unit-stubbing is awkward, assert on a synthetic catalog builder that wraps the helper)

Simplest approach for the catalog test:

```ts
test('buildModelCatalog exposes thinkingLevels from pi-ai', () => {
  // Use a minimal Model-shaped object; if getSupportedThinkingLevels needs more fields,
  // spy by building catalog through a thin export that accepts the helper as injectable,
  // OR just assert Array.isArray(buildModelCatalog(fastify)[0].thinkingLevels) with a
  // fake model that includes reasoning: true and thinkingLevelMap if required.
});
```

Prefer: in `buildModelCatalog`, for each `m` from `getAll()`, set  
`thinkingLevels: getSupportedThinkingLevels(m as any)`  
and test with a fake model that has `reasoning: false` → expect `['off']` or `[]` per actual helper behavior — **verify with a quick node one-liner before locking the assertion**.

- [ ] **Step 2: Implement catalog enrichment + type on `ModelCatalogItem`**

- [ ] **Step 3: Run** `npm run --workspace=src/backend test -- --test-name-pattern='buildModelCatalog'`

---

### Task 3: Chat stream applies `thinkingLevel`

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Modify: `src/backend/test/routes-chat.test.ts`
- Create (if not in Task 2): `src/backend/pi/thinking.ts` with `isThinkingLevel`

**ChatSession type** — extend Pick:

```ts
type ChatSession = Pick<AgentSession, 'subscribe' | 'prompt' | 'abort' | 'setModel' | 'getContextUsage' | 'setThinkingLevel' | 'supportsThinking'> & { ... }
```

**Apply logic** (after `setModel`, before `prompt`):

```ts
if (body.thinkingLevel !== undefined) {
  if (!isThinkingLevel(body.thinkingLevel)) {
    reply.code(400);
    return { error: `Invalid thinkingLevel: ${body.thinkingLevel}` };
  }
  if (selectedModel && session.supportsThinking?.()) {
    const clamped = clampThinkingLevel(selectedModel, body.thinkingLevel);
    session.setThinkingLevel(clamped);
  }
  // If no selectedModel or !supportsThinking: ignore (still send)
}
```

Note: validation of invalid strings must happen **before** `reply.hijack()` so 400 JSON still works. Place the check early next to model resolution (before claims/hijack), and call `setThinkingLevel` later once `session` exists — store `requestedThinkingLevel` in a local after validation.

- [ ] **Step 1: Tests** in `routes-chat.test.ts`:
  1. Valid level → mock session `setThinkingLevel` called with that level (or clamped), then `prompt`
  2. Invalid level → 400, `prompt` not called
  3. Omitted → `setThinkingLevel` not called
  4. Model without thinking (`supportsThinking: () => false`) → `setThinkingLevel` not called, stream still works

Follow existing stream test patterns (mock `pi.sessionFor`, etc.).

- [ ] **Step 2: Implement validation + apply**

- [ ] **Step 3: Run** `npm run --workspace=src/backend test -- test/routes-chat.test.ts` (or name-pattern for new tests)

---

### Task 4: Frontend stream + model types

**Files:**
- Modify: `src/frontend/src/hooks/useModels.ts` — `thinkingLevels?: ThinkingLevel[]`
- Modify: `src/frontend/src/hooks/usePiStream.ts` — add `thinkingLevel?: ThinkingLevel` to `startStream` opts and `requestBody`
- Modify tests if `usePiStream` / `useModels` have dedicated tests

- [ ] **Step 1: Implement type + pass-through**

- [ ] **Step 2: Typecheck** `npm run --workspace=src/frontend typecheck` (or project typecheck)

---

### Task 5: `ThinkingSelector` component

**Files:**
- Create: `src/frontend/src/components/ThinkingSelector.tsx`
- Create: `src/frontend/src/components/ThinkingSelector.test.tsx`

**Props:**

```ts
interface ThinkingSelectorProps {
  levels: ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}
```

Mirror `ModelSelector` portal/placement pattern but simpler (no search).  
`data-testid="thinking-selector"` on trigger; `data-testid="thinking-dropdown-list"` on menu.  
Return `null` if `levels.length === 0`.

- [ ] **Step 1: Tests** — renders label, lists levels, calls onChange, returns null for empty levels, respects disabled

- [ ] **Step 2: Implement component**

- [ ] **Step 3: Run** frontend vitest for the new file

---

### Task 6: Wire `ChatPanel`

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Modify: `src/frontend/src/components/ChatPanel.test.tsx`

**State:**

```ts
const [thinkingByThread, setThinkingByThread] = useState<Record<string, ThinkingLevel>>({});
```

Derive `thinkingLevel` for current thread (default `off`).  
When `activeModel?.thinkingLevels` changes, clamp and write back if needed.  
Render `<ThinkingSelector>` above the textarea row inside the composer chrome.  
Pass `thinkingLevel` into `startStream` via `submit`.  
Disable selector when `isRunning`.

- [ ] **Step 1: Tests** — with model `thinkingLevels: ['off','high']`, selector visible; selecting High includes `thinkingLevel: 'high'` in stream POST body; empty levels → no selector; running turn disables selector

- [ ] **Step 2: Wire UI + submit**

- [ ] **Step 3: Run** `npm run --workspace=src/frontend test -- ChatPanel.test.tsx ThinkingSelector.test.tsx`

---

### Task 7: Spec close-out

**Files:**
- Modify: `project_docs/specs/2026-07-24-pi-thinking-options-design.md` — fill **Implementation notes**

- [ ] Record what shipped, any deviations, verification checklist for testing agent
- [ ] Manual smoke (if `npm run web` available): pick a reasoning model, set High, send, see thinking block; set Off, send again

---

## Self-review vs spec

| Spec requirement | Task |
|------------------|------|
| Full Pi levels | 1, 2, 5 |
| Composer placement | 6 |
| Per-thread sticky | 6 |
| Clamp on model switch | 1, 6 |
| Catalog `thinkingLevels` | 2 |
| Stream pass-through + setThinkingLevel | 3, 4 |
| Hide when unsupported | 5, 6 |
| Glasses out of scope | — (no task) |
| Invalid → 400; unsupported ignore | 3 |
| Tests listed in design | 2, 3, 5, 6 |
