# Chat Implementation Progress - June 9, 2026

## Overview

Completed implementation of multi-thread chat system with Pure Pi architecture, including concurrent stream support, per-thread model persistence, and proper stream isolation.

## Architecture Changes

### Pure Pi Migration
- **Removed Zosma dependencies**: Eliminated all Zosma-specific code and dependencies
- **Direct Pi integration**: Chat now uses Pi runtime directly without abstraction layers
- **Simplified architecture**: Removed unnecessary complexity from hybrid approach

### Key Components
- **PiRuntime**: Manages agent sessions and model registry
- **ConcurrencyTracker**: Tracks active streams per project+model combination
- **usePiStream hook**: Handles streaming state and event routing with thread isolation
- **ChatPanel**: UI component with per-thread state management

## Features Implemented

### 1. Multi-Thread Chat
- ✅ Create multiple chat threads per project
- ✅ Each thread maintains independent conversation history
- ✅ Switch between threads without state bleed
- ✅ Input, messages, and model selection isolated per thread

### 2. Per-Thread Model Persistence
- ✅ Each thread remembers its selected model
- ✅ Model selection persists in database (`last_model_key` column)
- ✅ Model restores when returning to a thread
- ✅ Global model state tracks which model is active per thread

### 3. Concurrent Streams (Per Project+Model)
- ✅ Only one stream per project+model combination at a time
- ✅ Different models in same project can stream simultaneously
- ✅ Example: Thread A (Claude Sonnet) + Thread B (GPT-4) = both can stream
- ✅ Example: Thread A (Claude Sonnet) + Thread B (Claude Sonnet) = blocked

### 4. Stream Isolation
- ✅ `activeThreadRef` tracks which thread is currently active
- ✅ Events filtered based on thread ID
- ✅ Switching threads updates active thread reference
- ✅ Old streams continue in background but don't display in new thread

### 5. Model Busy Warning
- ✅ Real-time polling (every 2 seconds) checks if selected model is busy
- ✅ Warning banner appears when model is streaming in another thread
- ✅ Warning shows which thread is using the model
- ✅ User can still send (with confirmation) or wait

### 6. Streaming Features
- ✅ Real-time text streaming
- ✅ Thinking blocks with collapsible display
- ✅ Tool call timeline with diff viewer for edits
- ✅ Abort button to cancel streams
- ✅ Message persistence after stream completes

## Bugs Fixed

### Critical Bugs

1. **Message Duplication**
   - **Problem**: Messages appeared twice after sending
   - **Cause**: Stream state wasn't cleared before refreshing from API
   - **Fix**: Dispatch `RESET` action before fetching messages
   - **Commit**: `fix: clear stream state before refreshing messages`

2. **Message Bleed Across Threads**
   - **Problem**: Messages from Thread A appeared in Thread B
   - **Cause**: `loadedMessages` state persisted across thread switches
   - **Fix**: Clear `loadedMessages` immediately when switching threads
   - **Commit**: `fix: clear messages immediately when switching threads`

3. **Input Bleed Across Threads**
   - **Problem**: Typed text in Thread A appeared in Thread B's input
   - **Cause**: Input state not cleared when switching threads
   - **Fix**: Clear input in thread switch effect
   - **Commit**: `fix: clear chat input when switching threads`

4. **Model Bleed Across Threads**
   - **Problem**: Model selection from Thread A appeared in Thread B
   - **Cause**: Global `activeModelId` state shared across threads
   - **Fix**: Track model per thread using `activeModels` state
   - **Commit**: `fix: per-thread model selection`

5. **Stream Event Bleed**
   - **Problem**: Thread A's streaming output appeared in Thread B
   - **Cause**: `activeThreadRef` not updated when switching threads
   - **Fix**: Call `setActiveThread(threadId)` when thread changes
   - **Commit**: `fix: update activeThreadRef when switching threads`

### Medium Priority Bugs

6. **Concurrent Stream Blocking**
   - **Problem**: All threads in same project blocked from streaming
   - **Cause**: Concurrency tracked per-project instead of per-project+model
   - **Fix**: Changed concurrency key to `projectId::modelKey`
   - **Commit**: `feat: allow concurrent streams per project+model combination`

7. **Model Status Endpoint Crash**
   - **Problem**: Server crashed when checking model status
   - **Cause**: ModelKey with slashes treated as path separators
   - **Fix**: Use query parameter instead of path parameter
   - **Commit**: `fix: use query param for model status endpoint`

8. **Warning Not Appearing**
   - **Problem**: Model busy warning didn't show up
   - **Cause**: Only checked once when model selected, not polled
   - **Fix**: Poll every 2 seconds while model is selected
   - **Commit**: `feat: show warning when selected model is busy`

## Technical Implementation

### Backend Changes

#### Database Schema
```sql
ALTER TABLE chat_threads ADD COLUMN last_model_key TEXT;
```

#### API Endpoints
- `POST /api/threads/:threadId/messages/stream` - Stream messages (saves modelKey)
- `GET /api/threads/:threadId` - Returns thread with `last_model_key`
- `GET /api/projects/:projectId/model-status?modelKey=...` - Check if model is busy

#### ConcurrencyTracker
```typescript
class ConcurrencyTracker {
  private active = new Map<string, ActiveRun>();
  
  set(projectId: string, modelKey: string, threadId: string, title: string)
  get(projectId: string, modelKey: string): ActiveRun | undefined
  clear(projectId: string, modelKey: string)
}
```

### Frontend Changes

#### useModels Hook
```typescript
// Per-thread model tracking
const [activeModels, setActiveModels] = useState<Record<string, string>>({});
const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);

// Returns model for current thread
const activeModelId = currentThreadId ? activeModels[currentThreadId] : undefined;
```

#### usePiStream Hook
```typescript
// Thread-aware event filtering
const activeThreadRef = useRef<string | null>(null);

const routeEvent = useCallback((ev: any, threadId: string) => {
  if (activeThreadRef.current !== threadId) {
    return; // Filter out events from other threads
  }
  // Process event...
}, []);
```

#### ChatPanel Component
```typescript
// Clear state when switching threads
useEffect(() => {
  dispatch({ type: 'RESET' });
  setLoadedMessages([]);
  setModel('', '');
  setInput('');
  setActiveThread(threadId);
}, [threadId]);

// Poll for model busy status
useEffect(() => {
  const interval = setInterval(checkModelStatus, 2000);
  return () => clearInterval(interval);
}, [projectId, activeModelId, threadId]);
```

## Testing Scenarios

### Verified Working
1. ✅ Multi-thread chat with message isolation
2. ✅ Per-thread model persistence across app restarts
3. ✅ Concurrent streams with different models
4. ✅ Blocking concurrent streams with same model
5. ✅ Model busy warning appears correctly
6. ✅ Stream isolation when switching threads
7. ✅ Input and message state isolation
8. ✅ Thinking blocks display correctly
9. ✅ Tool calls display with timeline
10. ✅ Abort button works

### Known Limitations
1. Model selection requires manual selection for new threads (no default)
2. Warning only appears after 2-second polling delay
3. No visual indicator when a stream is running in background

## Files Modified

### Backend
- `src/backend/db.ts` - Added `last_model_key` column
- `src/backend/routes/chat.ts` - Stream endpoint, model status endpoint
- `src/backend/pi/concurrency.ts` - Per-project+model tracking
- `src/backend/pi/runtime.ts` - Session model tracking

### Frontend
- `src/frontend/src/hooks/useModels.ts` - Per-thread model state
- `src/frontend/src/hooks/usePiStream.ts` - Thread-aware event filtering
- `src/frontend/src/components/ChatPanel.tsx` - Thread switching, model busy warning
- `src/frontend/src/components/ThinkingBlock.tsx` - Thinking block display
- `src/frontend/src/components/ToolCallTimeline.tsx` - Tool call display

## Next Steps

### Phase 4: UI Polish (Not Started)
- Improve thinking block rendering (syntax highlighting, better formatting)
- Enhance tool call display (collapsible details, better icons)
- Add loading states for model selection
- Improve error messages and user feedback
- Add keyboard shortcuts (Ctrl+Enter to send, Esc to abort)

### Future Enhancements
- Default model selection for new threads
- Visual indicator for background streams
- Model usage statistics per thread
- Export chat history
- Search across threads

## Summary

The chat system is now fully functional with:
- **Multi-thread support** with proper isolation
- **Per-thread model persistence** that survives app restarts
- **Concurrent streams** allowed per project+model combination
- **Real-time warnings** when selecting busy models
- **Stream isolation** preventing cross-thread event bleed

All critical bugs have been resolved and the system is ready for use.
