/**
 * ChatPanel — the chat pane.
 *
 * Subscribes to the pi runtime's event stream for the active thread via
 * usePiStream. The X-Confirm-Cancel conflict path (different thread in
 * the same project is mid-run) surfaces as a confirm dialog.
 *
 * The previous file uploaded attachments, exported to JSONL, and used
 * a custom "Claude session resume" chip. All of that is gone:
 *   - Attachments: deferred to a follow-up (the route is still there at
 *     POST /api/threads/:id/upload but the UI doesn't expose it yet)
 *   - Export: pi sessions are already on disk in pi's tree format;
 *     the user can read them from ~/.nexus/sessions/{cwd-slug}/*.jsonl
 *   - Session resume: pi owns sessions natively; no terminal hand-off
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePiStream, ChatBusyError, type ChatAttachment, type ChatImageAttachment, type ContextUsage, type StreamMessage } from '../hooks/usePiStream';
import { useModels, parseModelKey } from '../hooks/useModels';
import { apiFetch } from '../api-base';
import { api } from '../api';
import { buildQuestionAnswerSummary, parseTerminalAskBlock, type QuestionAnswer, type QuestionRequest, type QuestionToolResult } from '../lib/questions';
import { ModelSelector } from './ModelSelector';
import { ToolCallTimeline, QuestionCards } from './ToolCallTimeline';
import { ThinkingBlock } from './ThinkingBlock';
import { QuestionCard } from './QuestionCard';
import { AgentRunCard } from './AgentRunCard';
import { useFollowAtBottom } from '../hooks/useFollowAtBottom';
import ArtifactPreviewRail from './ArtifactPreviewRail';
import ChatArtifactLinks from './ChatArtifactLinks';

interface ChatPanelProps {
  projectId: string;
  threadId: string | null;
  /** Called when the user confirms cancelling a busy thread in the same project. */
  onBusyConflict: (activeThreadId: string, activeTitle: string) => void;
  /** Called after a turn completes so the sidebar (title etc.) can refresh. */
  onThreadsChanged?: () => void;
  /** Reports whether this session is actively streaming/thinking/tooling. */
  onSessionActivityChange?: (threadId: string, active: boolean) => void;
  /** A task-seeded first turn. When `seed.threadId` matches the active thread,
   *  ChatPanel auto-submits `seed.prompt` once (with `seed.modelKey`) and calls
   *  `onSeedConsumed`. Used by the "Run task" flow to start the agent on open. */
  seed?: { threadId: string; prompt: string; modelKey: string } | null;
  onSeedConsumed?: () => void;
}

const MAX_PENDING_ATTACHMENTS = 5;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SUPPORTED_FILE_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

type QuestionSubmissionState = Record<string, {
  submitting?: boolean;
  error?: string;
  result?: QuestionToolResult;
}>;

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

function roundedContextPercent(usage: ContextUsage | null): number | null {
  if (!usage || usage.percent === null) return null;
  return Math.max(0, Math.round(usage.percent));
}

function ContextUsageLabel({ usage }: { usage: ContextUsage | null }) {
  if (!usage) return null;
  const percent = roundedContextPercent(usage);
  const used = usage.tokens === null ? null : formatCompactTokens(usage.tokens);
  const total = formatCompactTokens(usage.contextWindow);
  const isNearFull = percent !== null && percent >= 85;
  const label = `${percent === null ? '—' : `${percent}%`} ${used ? `(${used}/${total})` : `(${total})`}`;

  return (
    <div
      className={`h-4 text-right text-[11px] leading-4 ${isNearFull ? 'text-amber-200' : 'text-faint'}`}
      data-testid="context-usage"
      title={percent === null ? 'Context usage recalculating' : `Context usage: ${label}`}
    >
      {label}
    </div>
  );
}

function inferMimeType(file: File): string {
  if (file.type) return file.type;
  const lowerName = file.name.toLowerCase();
  const extension = Object.keys(EXTENSION_MIME_TYPES).find((ext) => lowerName.endsWith(ext));
  return extension ? EXTENSION_MIME_TYPES[extension] : '';
}

function isSupportedAttachment(file: File): boolean {
  const mimeType = inferMimeType(file);
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || SUPPORTED_FILE_MIME_TYPES.has(mimeType);
}

function fileToAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      const mimeType = inferMimeType(file);
      resolve({
        type: SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? 'image' : 'file',
        data: comma >= 0 ? result.slice(comma + 1) : result,
        mimeType,
        name: file.name,
        size: file.size,
      } as ChatAttachment);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment.'));
    reader.readAsDataURL(file);
  });
}

export default function ChatPanel({ projectId, threadId, onBusyConflict, onThreadsChanged, onSessionActivityChange, seed, onSeedConsumed }: ChatPanelProps) {
  const { models, activeModelId, setModel, setThread } = useModels();
  const { state, startStream, abortStream, detachStream, dispatch, setActiveThread } = usePiStream();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<StreamMessage[]>([]);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ activeThreadId: string; activeTitle: string; pendingText: string; pendingAttachments: ChatAttachment[] } | null>(null);
  const [modelBusy, setModelBusy] = useState<{ threadId: string; title: string; projectBusy?: boolean } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [questionSubmissions, setQuestionSubmissions] = useState<QuestionSubmissionState>({});
  const [fallbackSubmissions, setFallbackSubmissions] = useState<QuestionSubmissionState>({});
  const [artifactPath, setArtifactPath] = useState<string | null>(null);
  const [artifactRailOpen, setArtifactRailOpen] = useState(false);
  const streamContentVersion = [
    loadedMessages.length,
    state.messages.length,
    state.streamingMessage?.content.length ?? 0,
    state.streamingMessage?.run?.lastEventAt ?? 0,
    state.streamingMessage?.run?.tools.reduce((total, tool) => total + tool.partialOutput.length, 0) ?? 0,
  ].join(':');
  const { containerRef: messagesRef, isFollowing, onScroll, jumpToLatest } = useFollowAtBottom(streamContentVersion);

  const activeModel = models.find((model) => `${model.provider}/${model.id}` === activeModelId);
  const pendingImages = pendingAttachments.filter((attachment): attachment is ChatImageAttachment => attachment.type === 'image');
  const hasPendingImages = pendingImages.length > 0;
  const selectedModelSupportsImages = activeModel?.input?.includes('image') ?? false;
  const imageModelBlocked = hasPendingImages && !!activeModelId && !selectedModelSupportsImages;

  // Update the active thread in usePiStream to filter events correctly
  useEffect(() => {
    setActiveThread(threadId);
  }, [threadId, setActiveThread]);

  // Tell useModels which thread is active (for per-thread model tracking)
  useEffect(() => {
    setThread(threadId);
  }, [threadId, setThread]);

  useEffect(() => {
    if (!threadId || !onSessionActivityChange) return;
    onSessionActivityChange(threadId, state.isRunning);
  }, [threadId, state.isRunning, onSessionActivityChange]);

  // Reset local stream state and clear input when switching threads. The
  // backend run continues unless the user explicitly presses Stop.
  useEffect(() => {
    detachStream();
    dispatch({ type: 'RESET' });
    setError(null);
    setPendingConfirm(null);
    setInput('');
    setPendingAttachments([]);
    setAttachmentWarning(null);
    setArtifactPath(null);
    setArtifactRailOpen(false);
    setDraggingAttachments(false);
  }, [threadId, dispatch, detachStream]);

  // Check if the selected model is busy in another thread (poll every 2 seconds)
  useEffect(() => {
    if (!projectId || !activeModelId) {
      setModelBusy(null);
      return;
    }

    let cancelled = false;
    const checkStatus = async () => {
      try {
        const res = await apiFetch(`/api/projects/${projectId}/model-status?modelKey=${encodeURIComponent(activeModelId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          if (data.busy && data.activeThreadId !== threadId) {
            setModelBusy({ threadId: data.activeThreadId, title: data.activeTitle, projectBusy: data.projectBusy === true });
          } else {
            setModelBusy(null);
          }
        }
      } catch (err) {
        console.error('Failed to check model status:', err);
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId, activeModelId, threadId]);

  const openArtifactPreview = useCallback((path: string) => {
    setArtifactPath(path);
    setArtifactRailOpen(true);
  }, []);

  // Helper to fetch thread messages (without setting model)
  const fetchThreadMessages = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/threads/${id}`);
      if (!res.ok) throw new Error(`GET /api/threads/${id} ${res.status}`);
      const data = (await res.json()) as { messages: any[] };
      return (data.messages ?? []).map((m: any) => ({
        ...m,
        toolCalls: m.tool_calls ?? m.toolCalls ?? undefined,
      })) as StreamMessage[];
    } catch (err) {
      console.error('Failed to load thread messages', err);
      return [];
    }
  }, []);

  // Load persisted messages and restore thread's model when switching threads
  useEffect(() => {
    if (!threadId) {
      setLoadedMessages([]);
      setModel('', '');
      return;
    }
    
    // Clear messages and model immediately when switching threads
    setLoadedMessages([]);
    setQuestionSubmissions({});
    setFallbackSubmissions({});
    setModel('', '');
    
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/threads/${threadId}`);
        if (!res.ok) throw new Error(`GET /api/threads/${threadId} ${res.status}`);
        const data = (await res.json()) as { messages: any[]; thread?: any };
        
        // Restore the thread's saved model if it has one
        if (!cancelled && data.thread?.last_model_key) {
          const idx = data.thread.last_model_key.indexOf('/');
          if (idx > 0) {
            const provider = data.thread.last_model_key.slice(0, idx);
            const modelId = data.thread.last_model_key.slice(idx + 1);
            setModel(provider, modelId);
          }
        }
        
        if (!cancelled) {
          const msgs = (data.messages ?? []).map((m: any) => ({
            ...m,
            toolCalls: m.tool_calls ?? m.toolCalls ?? undefined,
          })) as StreamMessage[];
          setLoadedMessages(msgs);
        }
      } catch (err) {
        console.error('Failed to load thread messages', err);
        if (!cancelled) setLoadedMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, setModel]);

  // A task-seeded first turn fires exactly once per thread. The ref guard
  // keeps it from re-firing on remount, thread-switch, or the re-render that
  // clears the seed after `onSeedConsumed`. Runs after the load-messages
  // effect above so the seeded model wins over its initial blanking.
  const seededThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!seed || !threadId || seed.threadId !== threadId) return;
    if (seededThreadRef.current === threadId) return;
    seededThreadRef.current = threadId;
    const parsed = parseModelKey(seed.modelKey);
    if (parsed) void setModel(parsed.provider, parsed.id);
    void submit(seed.prompt, { modelKey: seed.modelKey });
    onSeedConsumed?.();
    // submit/setModel are stable enough; we intentionally key only on the seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, threadId]);

  // Ctrl+O toggles the details-expanded view (tool timeline, full thinking).
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        setDetailsExpanded((v) => !v);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const submit = useCallback(
    async (text: string, opts: { confirmCancel?: boolean; modelKey?: string; attachments?: ChatAttachment[]; onError?: (message: string) => void } = {}) => {
      if (!threadId) return;
      setError(null);
      const attachments = opts.attachments ?? pendingAttachments;
      let streamError: string | null = null;
      try {
        const contextUsage = await startStream(threadId, text, {
          confirmCancel: opts.confirmCancel,
          modelKey: opts.modelKey ?? activeModelId,
          attachments,
          onError: (message) => {
            streamError = message;
            setError(message);
            opts.onError?.(message);
          },
        });
        if (streamError) return false;
        onThreadsChanged?.();
        const msgs = await fetchThreadMessages(threadId);
        if (msgs.length > 0) {
          dispatch({ type: 'RESET', contextUsage });
          setLoadedMessages(msgs);
        }
        setPendingAttachments([]);
        setAttachmentWarning(null);
        return true;
      } catch (err) {
        if (err instanceof ChatBusyError) {
          setPendingConfirm({
            activeThreadId: err.activeThreadId,
            activeTitle: err.activeTitle,
            pendingText: text,
            pendingAttachments: attachments,
          });
          onBusyConflict(err.activeThreadId, err.activeTitle);
          return false;
        }
        if (attachments.length > 0) setPendingAttachments(attachments);
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [threadId, startStream, onBusyConflict, onThreadsChanged, activeModelId, pendingAttachments, fetchThreadMessages, dispatch],
  );

  const answerNativeQuestion = useCallback(async (toolCallId: string, answers: QuestionAnswer[]) => {
    if (!threadId) return;
    setQuestionSubmissions((current) => ({
      ...current,
      [toolCallId]: { ...current[toolCallId], submitting: true, error: undefined },
    }));
    try {
      await api.chat.answerQuestion(threadId, toolCallId, answers);
      setQuestionSubmissions((current) => ({
        ...current,
        [toolCallId]: {
          submitting: false,
          result: { status: 'answered', toolCallId, answers },
        },
      }));
    } catch (err) {
      setQuestionSubmissions((current) => ({
        ...current,
        [toolCallId]: {
          ...current[toolCallId],
          submitting: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, [threadId]);

  const answerFallbackQuestion = useCallback(async (
    messageId: string,
    request: QuestionRequest,
    answers: QuestionAnswer[],
  ) => {
    setFallbackSubmissions((current) => ({
      ...current,
      [messageId]: { ...current[messageId], submitting: true, error: undefined },
    }));
    const submitted = await submit(buildQuestionAnswerSummary(request, answers), {
      onError: (error) => {
        setFallbackSubmissions((current) => ({
          ...current,
          [messageId]: { ...current[messageId], submitting: false, error },
        }));
      },
    });
    if (!submitted) {
      setFallbackSubmissions((current) => ({
        ...current,
        [messageId]: { ...current[messageId], submitting: false },
      }));
      return;
    }
    setFallbackSubmissions((current) => ({
      ...current,
      [messageId]: {
        submitting: false,
        result: { status: 'answered', toolCallId: `fallback:${messageId}`, answers },
      },
    }));
  }, [submit]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (state.isRunning || (!text && pendingAttachments.length === 0) || !threadId || imageModelBlocked) return;
    const attachments = pendingAttachments;
    setInput('');
    setPendingAttachments([]);
    setAttachmentWarning(null);
    void submit(text, { attachments });
  }, [input, threadId, imageModelBlocked, pendingAttachments, state.isRunning, submit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const confirmCancelOther = useCallback(async () => {
    if (!pendingConfirm) return;
    const text = pendingConfirm.pendingText;
    const attachments = pendingConfirm.pendingAttachments;
    setPendingConfirm(null);
    setInput('');
    try {
      await submit(text, { confirmCancel: true, attachments });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pendingConfirm, submit]);

  const addAttachmentFiles = useCallback(async (files: File[]) => {
    const supportedFiles = files.filter(isSupportedAttachment);
    const rejected = files.length - supportedFiles.length;
    const slots = Math.max(0, MAX_PENDING_ATTACHMENTS - pendingAttachments.length);
    const accepted = supportedFiles.slice(0, slots);
    const overLimit = supportedFiles.length > slots;

    if (rejected > 0) {
      setAttachmentWarning('Attach images, PDFs, text, Word, Excel, or CSV files.');
    } else if (overLimit) {
      setAttachmentWarning(`Only ${MAX_PENDING_ATTACHMENTS} files can be attached to one message.`);
    } else {
      setAttachmentWarning(null);
    }

    if (accepted.length === 0) return;
    try {
      const attachments = await Promise.all(accepted.map(fileToAttachment));
      setPendingAttachments((current) => [...current, ...attachments].slice(0, MAX_PENDING_ATTACHMENTS));
    } catch (err) {
      setAttachmentWarning(err instanceof Error ? err.message : 'Failed to read attachment.');
    }
  }, [pendingAttachments.length]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingAttachments(false);
    void addAttachmentFiles(Array.from(e.dataTransfer.files));
  }, [addAttachmentFiles]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      setDraggingAttachments(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDraggingAttachments(false);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    void addAttachmentFiles(files);
  }, [addAttachmentFiles]);

  const removePendingAttachment = useCallback((index: number) => {
    setPendingAttachments((current) => current.filter((_, i) => i !== index));
    setAttachmentWarning(null);
  }, []);

  if (!threadId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-faint text-sm">Select a session, or use “+ New Session” in the tree to start one.</p>
        </div>
      </div>
    );
  }

  const visible = loadedMessages.concat(state.messages);
  const streaming = state.streamingMessage;
  const isRunning = state.isRunning;
  const isEmpty = visible.length === 0 && !streaming;
  // The latest assistant response stays expanded so the user can see what
  // they're replying to (issue #108). While a new run is streaming, none of
  // the existing assistant messages is "latest" — the new one is in flight —
  // so they collapse and the streaming response takes focus.
  const latestAssistantId = isRunning ? null : findLatestAssistantId(visible);

  return (
    <div className="flex-1 flex min-w-0 h-full">
      <div
        className="flex-1 flex flex-col min-w-0 h-full relative"
        data-testid="chat-drop-target"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
      {draggingAttachments && (
        <div className="absolute inset-3 z-20 rounded-lg border border-dashed border-cyan-300/50 bg-slate-950/70 flex items-center justify-center text-sm text-primary pointer-events-none">
          Release to attach files
        </div>
      )}
      <header className="px-4 py-2 border-b border-subtle surface-glass flex items-center gap-3">
        <ModelSelector
          models={models}
          currentModelId={activeModelId}
          onSelect={(p, id) => setModel(p, id)}
        />
        {activeModelId && (
          <span className="text-[10px] text-faint truncate" data-testid="active-model-label">
            {activeModelId}
          </span>
        )}
      </header>

      {modelBusy && (
        <div className="px-4 py-2 border-b border-amber-800/50 bg-amber-950/30 text-xs text-amber-200">
          <span className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span>
              {modelBusy.projectBusy
                ? `An autonomous mission is running in "${modelBusy.title}". Chat is paused on this project until it finishes.`
                : `This model is currently streaming in "${modelBusy.title}". Wait for it to finish or choose a different model.`}
            </span>
          </span>
        </div>
      )}

      {pendingConfirm && (
        <div className="px-4 py-2 border-b border-amber-800/50 bg-amber-950/30 text-xs text-amber-200 flex items-center gap-3">
          <span className="flex-1 min-w-0 truncate">
            “{pendingConfirm.activeTitle}” is still running. Start a new session anyway (will cancel it)?
          </span>
          <button
            onClick={() => setPendingConfirm(null)}
            className="px-2 py-0.5 rounded border border-subtle text-muted hover:text-white"
          >
            Wait
          </button>
          <button
            onClick={confirmCancelOther}
            className="px-2 py-0.5 rounded border border-amber-700 bg-amber-800/50 text-amber-100 hover:bg-amber-700/50"
          >
            Start (cancel)
          </button>
        </div>
      )}

      <div
        ref={messagesRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 space-y-3"
        data-testid="chat-messages"
      >
        {isEmpty ? (
          <p className="text-faint text-sm">Send a message to start.</p>
        ) : (
          visible.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              detailsExpanded={detailsExpanded}
              isLatest={m.id === latestAssistantId}
              questionState={questionSubmissions}
              fallbackState={fallbackSubmissions[m.id]}
              onAnswerQuestion={answerNativeQuestion}
              onAnswerFallback={answerFallbackQuestion}
              onOpenArtifact={openArtifactPreview}
              onStop={() => void abortStream('user')}
            />
          ))
        )}
        {streaming && (
          <MessageBubble
            msg={streaming}
            detailsExpanded={detailsExpanded}
            questionState={questionSubmissions}
            onAnswerQuestion={answerNativeQuestion}
            onAnswerFallback={answerFallbackQuestion}
            onOpenArtifact={openArtifactPreview}
            onStop={() => void abortStream('user')}
          />
        )}
      </div>

      {!isFollowing && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-28 right-6 z-10 rounded-full border border-subtle surface-elevated px-3 py-1.5 text-xs text-primary shadow-lg"
        >
          Jump to latest
        </button>
      )}

      {error && (
        <div className="px-4 py-2 border-t border-subtle text-xs text-red-300" role="alert">
          {error}
        </div>
      )}

      <div className="border-t border-subtle surface-glass p-3">
        {attachmentWarning && <div className="pb-2 text-xs text-amber-200">{attachmentWarning}</div>}
        {imageModelBlocked && (
          <div className="pb-2 text-xs text-amber-200">
            The selected model does not support images. Pick a vision-capable model or remove the images.
          </div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {pendingAttachments.map((attachment, index) => (
              <div
                key={`${attachment.name ?? attachment.type}-${index}`}
                data-testid="pending-attachment"
                className={`relative rounded-md overflow-hidden border border-subtle surface-elevated shrink-0 ${
                  attachment.type === 'image' ? 'w-20 h-16' : 'min-w-36 max-w-52 h-16 px-2 py-2'
                }`}
              >
                {attachment.type === 'image' ? (
                  <img
                    data-testid="pending-image-thumb"
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.name ?? `Image ${index + 1}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center gap-2 pr-6">
                    <span className="rounded border border-subtle px-1.5 py-0.5 text-[10px] uppercase text-muted">
                      {fileExtensionLabel(attachment.name)}
                    </span>
                    <span className="truncate text-xs text-primary">{attachment.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePendingAttachment(index)}
                  className="absolute right-1 top-1 w-5 h-5 rounded-full bg-zinc-950/85 text-xs text-primary"
                  aria-label={`Remove ${attachment.name ?? `attachment ${index + 1}`}`}
                >
                  x
                </button>
                {attachment.type === 'image' && attachment.name && (
                  <span className="absolute left-1 bottom-1 max-w-[4.5rem] truncate rounded bg-zinc-950/80 px-1 text-[9px] text-zinc-200">
                    {attachment.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            disabled={isRunning}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            rows={2}
            data-testid="chat-input"
            className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong"
          />
          <div className="flex min-w-[7.5rem] flex-col items-stretch gap-1" data-testid="composer-actions">
            <ContextUsageLabel usage={state.contextUsage} />
            {!isRunning && (
              <button
                type="button"
                onClick={handleSend}
                data-testid="send-button"
                disabled={(!input.trim() && pendingAttachments.length === 0) || imageModelBlocked}
                className="px-4 py-2 accent-button rounded-lg disabled:opacity-40 transition-colors"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      <ArtifactPreviewRail
        projectId={projectId}
        selectedPath={artifactPath}
        open={artifactRailOpen}
        onOpenChange={setArtifactRailOpen}
      />
    </div>
  );
}

function MessageBubble({
  msg,
  detailsExpanded,
  isLatest,
  questionState,
  fallbackState,
  onAnswerQuestion,
  onAnswerFallback,
  onOpenArtifact,
  onStop,
}: {
  msg: StreamMessage;
  detailsExpanded: boolean;
  isLatest?: boolean;
  questionState: QuestionSubmissionState;
  fallbackState?: QuestionSubmissionState[string];
  onAnswerQuestion: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
  onAnswerFallback: (messageId: string, request: QuestionRequest, answers: QuestionAnswer[]) => Promise<void>;
  onOpenArtifact: (path: string) => void;
  onStop: () => void;
}) {
  const isUser = msg.role === 'user';
  const isTool = msg.role === 'toolResult';
  const isThinking = msg.isStreaming === true && !msg.content && !!msg.thinking;
  const fallback = !isUser && !isTool && msg.isStreaming !== true
    ? parseTerminalAskBlock(msg.content)
    : null;
  if (!isUser && !isTool && msg.run) {
    return (
      <div className="flex justify-start">
        <AgentRunCard
          run={msg.run}
          content={msg.content}
          thinking={msg.thinking}
          detailsExpanded={detailsExpanded}
          isLatest={isLatest}
          onStop={onStop}
          questionState={questionState}
          onAnswerQuestion={onAnswerQuestion}
          onOpenArtifact={onOpenArtifact}
        />
      </div>
    );
  }
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-chat-role={isUser ? 'user' : isTool ? 'tool' : 'assistant'}
        className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm ${
          isUser
            ? 'chat-request-bubble'
            : isTool
              ? 'surface-panel border border-subtle text-muted text-xs'
              : 'surface-glass border border-subtle text-primary'
        }`}
      >
        {!isUser && msg.thinking && (
          <ThinkingBlock
            thinking={msg.thinking}
            isThinking={isThinking}
            expanded={detailsExpanded}
          />
        )}
        {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mb-2">
            <ToolCallTimeline
              toolCalls={msg.toolCalls as any}
              detailsExpanded={detailsExpanded}
            />
          </div>
        )}
        {isUser && msg.attachments && msg.attachments.length > 0 && (
          <div className="mb-2 grid grid-cols-2 gap-2">
            {msg.attachments.map((attachment, index) => (
              attachment.type === 'image' ? (
                <img
                  key={`${attachment.name ?? 'image'}-${index}`}
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt={attachment.name ?? `Attached image ${index + 1}`}
                  className="max-h-40 rounded-lg border border-subtle object-cover"
                />
              ) : (
                <div
                  key={`${attachment.name}-${index}`}
                  className="min-w-0 rounded-md border border-subtle bg-zinc-950/35 px-2 py-1.5 text-xs text-primary"
                >
                  <span className="mr-2 rounded border border-subtle px-1.5 py-0.5 text-[10px] uppercase text-muted">
                    {fileExtensionLabel(attachment.name)}
                  </span>
                  <span className="break-all">{attachment.name}</span>
                </div>
              )
            ))}
          </div>
        )}
        {isTool ? (
          <div>
            <span>
              <code className="text-faint">{msg.toolName}</code>
              {msg.isError ? ' (error)' : ''}
            </span>
            {msg.signal_filter && msg.signal_filter.saved_bytes > 0 && (
              <span
                className="ml-2 text-[10px] text-emerald-400/80"
                title={`Applied filters: ${msg.signal_filter.applied_filters.join(', ')}`}
              >
                Model context: {msg.signal_filter.saved_percent}% smaller
              </span>
            )}
            {detailsExpanded && msg.content && (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-[11px] text-zinc-400/80">
                {msg.content}
              </pre>
            )}
          </div>
        ) : fallback ? (
          <div className="space-y-3">
            {fallback.preamble && <p className="whitespace-pre-wrap">{fallback.preamble}</p>}
            <QuestionCard
              request={fallback.request}
              answeredResult={fallbackState?.result}
              submitting={fallbackState?.submitting}
              error={fallbackState?.error}
              onSubmit={(answers) => onAnswerFallback(msg.id, fallback.request, answers)}
            />
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap">
              {isUser ? msg.content : <ChatArtifactLinks text={msg.content} onOpenPath={onOpenArtifact} />}
            </p>
            {/* Native question tools render after the prelude text, at the
                bottom of the bubble (issue #109). */}
            {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
              <QuestionCards
                toolCalls={msg.toolCalls as any}
                questionState={questionState}
                onAnswerQuestion={onAnswerQuestion}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function fileExtensionLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return 'file';
  return name.slice(dot + 1, dot + 5);
}

/** Id of the last assistant (non-user, non-toolResult) message in the list,
 *  or null if there is none. Used to mark the latest response so it stays
 *  expanded until the user replies (issue #108). */
function findLatestAssistantId(messages: StreamMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'toolResult') return m.id;
  }
  return null;
}
