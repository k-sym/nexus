# Pure Pi Architecture Design

**Date:** 2026-06-09  
**Status:** Approved  
**Goal:** Multi-project chat interface using subscription-based AI agents (Claude Code, Codex, OpenCode) via Pi runtime

---

## Problem Statement

The current Nexus codebase is a hybrid of a legacy chat prototype and Pi runtime, creating architectural confusion:
- 45+ legacy chat references scattered through code
- Custom auth layer duplicating Pi's AuthStorage
- Legacy session migration scripts
- Legacy auth components and hooks

**User's goal:** Use subscription-based agents (not API tokens) across multiple projects with seamless context switching.

**Why Pi?** Pi runtime already provides:
- OAuth for Claude Code, Codex, OpenCode subscriptions
- 254+ models via registry (including OpenRouter)
- Session management (JSONL on disk)
- Streaming events (thinking, text, tools)
- Tool support (file ops, bash, grep, etc.)

---

## Architecture: Pure Pi

Nexus becomes a thin web UI layer on top of Pi's runtime. Pi handles everything complex; Nexus adds multi-project/multi-thread UX.

### Backend (Fastify)

```
Fastify server
├── PiRuntime (single instance)
│   ├── AuthStorage (~/.nexus/auth.json)
│   ├── ModelRegistry (254+ models)
│   └── Session cache (Map<threadId::cwd, AgentSession>)
├── Routes
│   ├── /api/projects/* - CRUD projects
│   ├── /api/projects/:id/threads - list/create threads
│   ├── /api/threads/:id/messages/stream - NDJSON stream
│   ├── /api/models - list available models
│   └── /api/auth/* - OAuth + API key management
└── SQLite (projects, threads metadata only)
```

**Key simplifications:**
- No `chat_messages` table (Pi stores messages in JSONL)
- No custom auth layer (Pi's AuthStorage handles it)
- No legacy chat migration scripts
- No legacy chat session column

### Frontend (React)

```
React SPA
├── Sidebar
│   ├── Project list
│   └── Thread list (per project)
├── ChatPanel
│   ├── ModelSelector (Pi model registry)
│   ├── Message stream (NDJSON consumer)
│   │   ├── Thinking blocks (collapsible, streaming deltas)
│   │   ├── Text content (streaming)
│   │   └── Tool calls (status, args, results)
│   └── Input + send/abort
└── Settings
    └── Auth management (Pi OAuth + API keys)
```

**UI capabilities:**
- **Streaming text** - real-time token-by-token display
- **Thinking blocks** - collapsible, with streaming deltas
- **Tool calls** - show tool name, args, execution status, results
- **Bidirectional** - send messages, receive responses, abort mid-stream
- **Model switching** - pick model per message from Pi registry
- **Session persistence** - switch projects/threads, return with full history

### Auth Flow

1. **OpenRouter**: API key via Settings → stored in Pi's AuthStorage
2. **Claude Code/Codex/OpenCode**: OAuth via Pi's built-in flow → subscription tokens stored
3. On boot, backend registers all known API keys with Pi runtime via `setRuntimeApiKey()`

### Data Model

**SQLite (minimal):**
```sql
projects (id, name, repo_path, created_at)
chat_threads (id, project_id, title, created_at, updated_at)
```

**Pi handles:**
- Session files: `~/.nexus/sessions/{cwd-slug}/{threadId}.jsonl`
- Auth: `~/.nexus/auth.json`
- Model registry: built-in + OpenRouter

---

## What We Delete

### Backend
- Legacy auth components and hooks
- Legacy chat migration script
- Legacy chat session column from `chat_threads`
- `chat_messages` table (Pi stores in JSONL)
- All legacy-port comments
- Custom auth wrapper around Pi's AuthStorage

### Frontend
- Legacy auth component and tests
- Legacy auth hook
- Any legacy-specific session handling

---

## What We Keep

### Backend
- `PiRuntime` class (already works)
- OpenRouter auth registration (just fixed)
- Session management via `sessionFor(threadId, cwd)`
- NDJSON streaming route
- Model registry integration

### Frontend
- `usePiStream` hook (handles thinking, text, tools)
- `ModelSelector` component (uses Pi registry)
- `ChatPanel` with streaming display
- Project/thread sidebar structure

---

## Implementation Phases

### Phase 1: Strip Legacy Chat Layer (1-2 hours)
1. Delete legacy auth component and hook
2. Remove legacy chat migration script
3. Drop legacy chat session column
4. Remove `chat_messages` table
5. Clean up comments and references

### Phase 2: Simplify Auth (30 min)
1. Use Pi's AuthStorage directly in Settings UI
2. Remove custom auth wrapper
3. Test OAuth flow for Claude/Codex/OpenCode

### Phase 3: Verify Chat Flow (30 min)
1. Test multi-project switching
2. Test multi-thread within project
3. Test model switching per message
4. Verify session persistence

### Phase 4: Polish UI (1 hour)
1. Ensure thinking blocks render correctly
2. Verify tool call display
3. Test abort functionality
4. Add loading states

---

## Success Criteria

- [ ] Can create multiple projects
- [ ] Can create multiple threads per project
- [ ] Can switch between projects/threads seamlessly
- [ ] Can pick different models per message
- [ ] Chat streams thinking + text + tools in real-time
- [ ] Sessions persist across app restarts
- [ ] OAuth works for Claude Code, Codex, OpenCode
- [ ] OpenRouter API key works
- [ ] No legacy chat references in codebase
- [ ] Typecheck passes
- [ ] All tests pass (or are deleted if legacy-specific)

---

## Risks & Mitigations

**Risk:** Pi's OAuth flow might not work in web context  
**Mitigation:** Test early in Phase 2; fallback to manual token entry if needed

**Risk:** Session cache might grow too large  
**Mitigation:** Add LRU eviction or periodic cleanup

**Risk:** `setModel()` on cached sessions might fail  
**Mitigation:** Already added error handling; log but don't fail request

---

## Open Questions

1. Should we add a "clear session" button to reset a thread?
2. Do we want to show token usage per message?
3. Should we add export functionality (JSONL → markdown)?

---

## Conclusion

Pure Pi architecture gives us:
- **Simpler codebase** - no hybrid confusion
- **Better auth** - Pi's OAuth for subscriptions
- **More models** - 254+ via Pi registry
- **Full features** - streaming, thinking, tools, persistence

The previous implementation tried to merge a legacy chat prototype and Pi, creating debt. This design strips the legacy layer and uses Pi directly, achieving the user's goal of a multi-project chat interface with subscription-based agents.
