# Next-message suggestion

**Date:** 2026-07-22
**Status:** Design — approved, not yet implemented
**Surfaces:** Desktop chat (ChatPanel) + Assistant (AssistantView). Glasses enabled but out of scope.

## What we're building

When an assistant turn finishes, Nexus predicts the user's *next message* and offers it in the
composer as dim placeholder text. `Tab` accepts it into the input without sending; the user can
edit it, then `Enter` as normal. Anything else the user types dismisses it.

One suggestion, not a menu. It predicts the user's move, not the assistant's — "run the tests",
"yes, do that", "what about the glasses client?" — which is why it reads as useful rather than as
autocomplete.

The motivating surface is actually the **Even G2 glasses**, where there is no keyboard and a
slide-to-pick suggestion is a primary input path rather than a convenience. Desktop is first
because it iterates in an `npm run dev` loop with no repack cycle. The design deliberately puts
all the work behind a stateless endpoint so the glasses need no new backend work later.

## Why not prompt injection

The obvious cheap build is to append "end every response with `<next>…</next>`" to the system
prompt and strip the span out of the stream client-side. We rejected it, on evidence specific to
this codebase rather than on principle.

**Nexus does not own the assistant-side write.** Per
[`gateway/sessions.ts`](../../src/backend/gateway/sessions.ts):

> `chat_messages` holds only the user side — a chat thread's assistant replies live in the pi
> store on disk

[`routes/chat.ts`](../../src/backend/routes/chat.ts) persists the user turn and nothing else. Pi's
session manager owns the assistant text on disk and replays it as context on the next turn. An
injected tag would therefore be written into Pi's store *by Pi*, and stripping it at render time
in the frontend would leave the model reading every suggestion it had ever made, accumulating each
turn. Fixing that means reaching into the SDK's storage layer to undo something we asked it to do.

Three further costs, all avoided by a second call:

- it taxes the main model on every turn, including long expensive ones;
- it can't be cancelled or fail silently — it is welded to the turn;
- it must be obeyed and stripped per provider (Claude Code, Codex, OpenCode, OpenRouter).

Streaming extraction itself is *not* the blocker. A tail-buffer that withholds any suffix which
could be a sentinel prefix is roughly 40 lines. Persistence is the blocker.

**What we give up:** injection sees the assistant's full reasoning about what it just did; a
second call sees only the transcript. Accepted — the transcript tail carries enough to predict the
user's next move, and quality is tunable in one prompt.

## Architecture

Three thin layers, each modelled on [`sessions/auto-title.ts`](../../src/backend/sessions/auto-title.ts),
which is already this feature for titles: a small local-model call, fire-and-forget, silent on
failure.

```
ChatPanel / AssistantView
  └─ useNextSuggestion(sessionKey, turnKey, messages)   [frontend hook, abortable]
       └─ POST /api/next-message  { transcript }        [backend route, stateless]
            └─ daemon.generateNextMessage({ transcript })
                 └─ POST /operations/generate-next-message   [memory daemon]
                      └─ ctx.models.complete()   [local gen server]
```

### Trigger: frontend, after the stream closes

The suggestion can only be computed once the reply exists, by which point the NDJSON stream is
already closing. Holding `run_end` open to wait for it would make every turn *look* slower to save
one round-trip. So the frontend fires a separate `POST` after the stream closes. That also makes it
trivially abortable on thread switch or first keystroke, which a pushed stream event would not be.

### Backend route: stateless, transcript in the body

`POST /api/next-message`, body `{ transcript: TranscriptTurn[] }`:

```ts
interface TranscriptTurn { role: 'user' | 'assistant'; text: string }

// 200
{ suggestion: string }   // '' means "nothing worth offering"
// 400 malformed body — the only error status
```

A daemon that is down or a model that fails is **not** an error status. It logs to the backend
console and returns `{ suggestion: '' }`, because the caller's behaviour is identical either way:
show no placeholder. This is the same contract `auto-title.ts` states — failure must never surface
as anything the user has to acknowledge.

**The caller supplies the transcript rather than the server re-reading it.** An earlier draft of
this design had the endpoint take a session id and rebuild the transcript server-side via
`resolveSession` + `readEvents` from `gateway/sessions.ts`, which meant extracting the
module-private assistant reader out of `routes/assistant.ts`, threading a Hermes client and session
directory into a new shared module, and unpicking a loopback HTTP call. That is two refactoring
tasks before a single line of feature code — to reconstruct data the caller is already holding in
state and has just finished rendering.

Every client that could want a suggestion already has the transcript: ChatPanel and AssistantView
hold it in their stream reducers, and the glasses receive it from `buildDetail`. So the endpoint
takes it as input and stays stateless — no db reads, no session resolution, no per-surface backend
code at all. "Both surfaces from one endpoint" gets *cheaper* under this design, not dearer.

Trusting caller-supplied content is not a concern worth engineering against here: Nexus is a
local single-user app, and the content travels to a local model and back to the same user as a
suggestion in their own composer. No privilege boundary is crossed.

Validation is about bounding the model call, not about trust — reject a non-array body with 400,
keep the last 20 turns, cap each at 2000 chars and the whole context at 8000.

Skip the model call and return `{ suggestion: '' }` when the transcript carries no assistant turn:
there is nothing to predict from.

That is the only backend skip condition. The other case where a suggestion is unwanted — the turn
errored or was aborted — is frontend state, and the hook does not fire in it.

**Deferred:** suppressing the suggestion while a structured question card is pending. A card
already offers concrete options, so a placeholder alongside it is mildly redundant — but only
mildly, since the composer is empty either way and the placeholder is dim. Wiring
`questionSubmissions` into the enabled predicate is more plumbing than that redundancy justifies
in v1.

**The gateway's loopback read is left alone.** It is a real wart, and exporting the assistant
reader would fix it, but it is now unrelated to this feature. Worth its own issue, not a rider
on this one.

### Daemon route

`POST /operations/generate-next-message`, body `{ transcript: string }`, alongside
`generate-session-title` in
[`routes/operations.ts`](../../src/memory-daemon/src/routes/operations.ts). Same shape:
`ctx.models.complete()` with a system prompt, low temperature, small `maxTokens`, explicit timeout,
`502` with a forwarded `ModelError` detail on failure.

The daemon takes a pre-rendered string, not structured turns — the backend flattens
`TranscriptTurn[]` into `User: …` / `Assistant: …` lines, matching how
`summarize-session-archive` already takes a rendered `transcript` string.

```ts
const NEXT_MESSAGE_SYSTEM_PROMPT =
  "You predict the user's next message in a coding session. Read the transcript and reply with " +
  "the single most likely thing the user will say next, in their voice, as a short instruction " +
  "or question. Reply with that message alone: no quotes, no preamble, no explanation. Reply " +
  "with nothing at all if the next move is not predictable.";
```

`temperature: 0.3`, `maxTokens: 48`, `timeoutMs: 20_000`.

A `cleanSuggestion()` helper mirrors `cleanSessionTitle()` — small local models pad output with
preamble and quotes no matter how firmly the prompt forbids it. Keep the first non-empty line,
strip leading `Next message:` / `User:` labels and wrapping quotes, drop trailing punctuation
noise, cap at 160 chars, and return `''` if what survives is empty.

The 20s timeout is generous on purpose: a late arrival costs nothing because the frontend guard
(below) discards anything that lands after the user has moved on.

## Frontend

### `useNextSuggestion`

`useNextSuggestion({ sessionKey, turnKey, messages, enabled })` — one shared hook for both
surfaces. Returns `{ suggestion, dismiss }`.

`turnKey` is the id of the trailing assistant message. It changes exactly once per turn, which
makes it both the fire trigger and the staleness token. `null` means "no completed turn", and the
hook stays idle. Message id rather than `runId` because AssistantView's messages carry no run
metadata, and one signal has to work on both surfaces.

`sessionKey` is whatever id the surface uses (`threadId` or assistant `sessionId`); the hook only
compares it for staleness and never sends it. `messages` is the surface's own message list, which
the hook reduces to `TranscriptTurn[]` — both reducers already expose `{ role, content }`, so one
mapper covers both.

- fires when `turnKey` changes to a non-null value **and** `enabled` is true. The caller passes
  `enabled = composer is empty && turn ended cleanly`, so each surface states those conditions in
  its own terms rather than the hook knowing about either;
- holds an `AbortController`; aborts on unmount, on `sessionKey` change, and on `dismiss()`;
- discards a response whose `sessionKey`/`turnKey` no longer match the current ones, so a slow
  daemon can never paste a stale suggestion into a new thread;
- swallows every error. No toast, no banner, no log noise in the UI. An unreachable daemon or a
  slow model must never degrade chat — the same contract `auto-title.ts` states in its header.

### Rendering: the placeholder trick

True inline ghost text in a `<textarea>` normally needs an overlaid mirror element, because you
cannot style text after the cursor. We avoid that entirely: the suggestion is only ever shown when
the composer is **empty**, and an empty textarea is exactly when `placeholder` renders. So the
suggestion goes in `placeholder`, styled dim, with the existing placeholder as the fallback.

No overlay, no mirror div, no scroll-sync. The constraint that made the feature simple to reason
about also made it simple to render.

### Key handling

In `handleKeyDown` ([`ChatPanel.tsx`](../../src/frontend/src/components/ChatPanel.tsx)), and the
equivalent in `AssistantView`:

- `Tab` with a suggestion present → `preventDefault()` (textareas move focus otherwise),
  `setInput(suggestion)`, `dismiss()`. **Does not send.** Accepting and sending stay separate so
  editing is free.
- `Escape` → `dismiss()`.
- any other key → `dismiss()` via the existing `onChange`, since typing makes the composer
  non-empty.

A small dim `⇥` affordance next to the composer while a suggestion is live, for discoverability.

## Failure modes

| Failure | Behaviour |
|---|---|
| Daemon down / gen server wedged | No placeholder. Chat unaffected. |
| Model returns junk or empty | `cleanSuggestion()` yields `''` → no placeholder. |
| Response lands after user typed | Guard drops it; composer is non-empty. |
| Response lands after thread switch | Guard drops it on `sessionKey` mismatch. |
| Suggestion is simply wrong | User types over it. Cost is one dim line they ignore. |

## Testing

Mirroring existing conventions — `auto-title.test.ts` injects a `deps.generate`, so the route tests
never need a live model.

- **Daemon** (`memory-daemon/test`): route returns a cleaned suggestion; `cleanSuggestion` strips
  preamble/quotes/labels and caps length; empty model output → `''`; `ModelError` → 502 with detail.
- **Backend** (`backend/test`): a transcript with no assistant turn returns `{ suggestion: '' }`
  without calling the injected generator; a non-array body → 400; over-long transcripts are
  truncated to the documented caps before the generator sees them; daemon throw → non-2xx with no
  exception escaping.
- **Frontend**: hook aborts in flight on thread switch; discards a stale-`turnKey` response; does
  not fire when `enabled` is false. `ChatPanel` test: `Tab` fills the input and does not submit; typing clears the
  placeholder.

## Out of scope

- **Glasses.** The endpoint is stateless and surface-agnostic, so the cockpit's Steer screen
  can adopt it with no backend change — slide to highlight, tap to send. Deliberately deferred until
  suggestion quality has been lived with on desktop.
- **Multiple suggestions.** One suggestion, decided explicitly. A glasses pick-list would want N,
  and that is a generator change at the time it is needed, not now.
- **Learning from accept/reject.** No telemetry, no per-user tuning. Prompt-only quality.
- **Suggesting anything other than a next user message** — no tool proposals, no action buttons.
