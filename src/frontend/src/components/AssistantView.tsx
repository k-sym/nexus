import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PaperPlaneRight, Paperclip, Stop, Trash } from '@phosphor-icons/react';
import {
  AssistantMessage,
  useAssistantStream,
} from '../hooks/useAssistantStream';
import { confirmDialog } from '../lib/confirm';
import { useNextSuggestion } from '../hooks/useNextSuggestion';
import { AttachmentChip, fileExtensionLabel, usePendingAttachments } from '../lib/attachments';
import { AgentRunCard } from './AgentRunCard';
import { RunStatusStrip } from './RunStatusStrip';
import { ToolCallTimeline } from './ToolCallTimeline';

// The one-conversation model (baker-internal#114 / #381): the partner has ONE
// current session, held server-side and shared with every other surface
// (Telegram, and whatever comes next). This view never chooses a session — it
// renders whatever the pointer says. `/new` rotates; there is no session rail,
// no picker, and none is wanted. Rotation is also the archive path: the
// memory-flush hooks harvest transcripts, so old conversations become memory,
// not tabs.
export default function AssistantView() {
  const {
    selectedSession,
    selectedSessionId,
    messages,
    latestRun,
    isRunning,
    error,
    loadCurrent,
    send,
    abort,
    clear,
  } = useAssistantStream();
  const [input, setInput] = useState('');
  // The trailing assistant message identifies the completed turn: it changes
  // exactly once per turn, so it serves as both trigger and staleness token.
  const lastMessage = messages[messages.length - 1];
  const completedTurnKey =
    !isRunning && lastMessage?.role === 'assistant' && lastMessage.content.trim()
      ? lastMessage.id
      : null;
  const { suggestion, dismiss: dismissSuggestion } = useNextSuggestion({
    sessionKey: selectedSessionId ?? null,
    turnKey: completedTurnKey,
    messages,
    // Only ever offered into an empty composer — which is also the only time a
    // placeholder renders, and why this needs no ghost-text overlay.
    enabled: !isRunning && !input.trim(),
  });
  const {
    pendingAttachments,
    attachmentWarning,
    addAttachmentFiles,
    removePendingAttachment,
    clearPendingAttachments,
  } = usePendingAttachments();
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSelectedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    void loadCurrent();
  }, [loadCurrent]);

  useEffect(() => {
    if (lastSelectedSessionIdRef.current && lastSelectedSessionIdRef.current !== selectedSessionId) {
      setConfirmingDelete(false);
    }
    lastSelectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || !selectedSessionId) return;
    if (text === '/new' && pendingAttachments.length === 0) {
      const rotated = await loadCurrent(true);
      if (rotated) setInput('');
      return;
    }
    if (text === '/clear' && pendingAttachments.length === 0) {
      if (!(await confirmDialog('Delete this conversation? This cannot be undone.'))) return;
      const cleared = await clear();
      if (cleared) {
        setInput('');
        await loadCurrent();
      }
      return;
    }
    if (isRunning) return;
    // Clear the composer the moment the message leaves — the user bubble is
    // already on screen; holding the text until the turn completes made every
    // long turn look like the send hadn't registered. Restore it on failure.
    const sentAttachments = pendingAttachments;
    setInput('');
    clearPendingAttachments();
    const sent = await send(text, sentAttachments);
    if (!sent) setInput(text);
  }, [clear, clearPendingAttachments, input, isRunning, loadCurrent, pendingAttachments, selectedSessionId, send]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && suggestion && !input) {
      // Accept into the composer without sending: editing before Enter is free.
      e.preventDefault();
      setInput(suggestion);
      dismissSuggestion();
      return;
    }
    if (e.key === 'Escape' && suggestion) {
      dismissSuggestion();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const trimmedInput = input.trim();
  const canSubmit = !!selectedSessionId && (!!trimmedInput || pendingAttachments.length > 0);

  // The Assistant is project-less: there's no preview rail to open an artifact
  // into. Presence of the handler is what enables ChatMessageContent's
  // markdown/path rendering inside AgentRunCard; the no-op is intentional.
  const openArtifact = useCallback((_path: string) => { /* project-less: no preview rail */ }, []);

  return (
    <div
      className="flex-1 flex min-h-0 relative"
      data-testid="assistant-drop-target"
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDraggingAttachments(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDraggingAttachments(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDraggingAttachments(false);
        void addAttachmentFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {draggingAttachments && (
        <div className="absolute inset-3 z-20 rounded-lg border border-dashed border-cyan-300/50 bg-slate-950/70 flex items-center justify-center text-sm text-primary pointer-events-none">
          Release to attach files
        </div>
      )}
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="surface-glass flex items-center justify-between px-6 py-3 border-b border-subtle shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{selectedSession?.title ?? 'Partner'}</h2>
            <div className="flex items-center gap-2 text-xs text-faint">
              <span className="truncate">One conversation, every surface — /new starts fresh</span>
              {selectedSession?.updated_at && <span className="shrink-0">· {relativeUpdatedAt(selectedSession.updated_at)}</span>}
              {latestRun?.remote_run_id && <span className="truncate shrink-0">· remote {latestRun.remote_run_id}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!selectedSessionId}
              className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-red-300 hover:border-strong transition-colors disabled:opacity-40"
              title="Delete this conversation"
              aria-label="Delete this conversation"
            >
              <Trash size={16} />
            </button>
          </div>
        </header>

        {confirmingDelete && selectedSessionId && (
          <div
            role="alertdialog"
            aria-label="Confirm delete conversation"
            className="surface-panel border-b border-subtle px-6 py-2 flex items-center justify-end gap-2 text-xs text-muted"
          >
            <span className="mr-auto text-primary">Delete this conversation?</span>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="h-8 px-3 surface-elevated border border-subtle rounded-lg hover:text-[var(--text-primary)] hover:border-strong transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                const cleared = await clear();
                if (cleared) {
                  setConfirmingDelete(false);
                  await loadCurrent();
                }
              }}
              className="h-8 px-3 rounded-lg border border-red-400/35 text-red-200 bg-red-950/35 hover:border-red-300 transition-colors"
              aria-label="Confirm delete conversation"
            >
              Delete
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <p className="text-faint text-sm">Send a message to start.</p>
          ) : (
            // Standalone tool-result rows are hidden: their output is already
            // rendered (folded) inside the owning assistant message's tool-call
            // timeline, so showing them again would dump raw tool output as its
            // own bubble — the exact regression this filter prevents.
            messages
              .filter((message) => message.role !== 'toolResult' && message.role !== 'tool')
              .map((message) =>
              message.role !== 'user' ? (
                message.run ? (
                  <div key={message.id} className="flex justify-start">
                    <AgentRunCard
                      run={message.run}
                      content={message.content}
                      thinking={message.thinking}
                      detailsExpanded={false}
                      onOpenArtifact={openArtifact}
                    />
                  </div>
                ) : (
                  // Fallback for assistant messages that somehow lack a `run`
                  // (e.g. legacy rows seeded before Pi-backed sessions existed).
                  <AssistantBubble key={message.id} message={message} />
                )
              ) : (
                <AssistantBubble key={message.id} message={message} />
              ),
            )
          )}
        </div>

        {error && (
          <div className="px-4 py-2 border-t border-subtle text-xs text-red-300" role="alert">
            {error}
          </div>
        )}

        {isRunning && (
          <RunStatusStrip
            run={messages.slice().reverse().find((m) => m.run)?.run ?? null}
            fallbackLabel="Working…"
          />
        )}

        <div className="border-t border-subtle surface-glass p-3">
          {attachmentWarning && <div className="pb-2 text-xs text-amber-200">{attachmentWarning}</div>}
          {pendingAttachments.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {pendingAttachments.map((attachment, index) => (
                <AttachmentChip
                  key={`${attachment.name ?? attachment.type}-${index}`}
                  attachment={attachment}
                  index={index}
                  onRemove={removePendingAttachment}
                />
              ))}
            </div>
          )}
          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void addAttachmentFiles(Array.from(e.target.files ?? []));
                e.currentTarget.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!selectedSessionId}
              className="h-10 w-10 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors disabled:opacity-40"
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip size={17} />
            </button>
            <textarea
              value={input}
              onChange={(e) => {
                // Typing their own words retires the suggestion for good — it
                // does not reappear if they then clear the box again.
                if (suggestion) dismissSuggestion();
                setInput(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length === 0) return;
                e.preventDefault();
                void addAttachmentFiles(files);
              }}
              placeholder={suggestion || 'Message your partner...'}
              rows={2}
              disabled={!selectedSessionId}
              className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-hidden focus:border-strong disabled:opacity-50"
            />
            {isRunning ? (
              <button
                type="button"
                onClick={() => void abort()}
                aria-label="Stop current run"
                className="h-10 px-4 accent-button rounded-lg transition-colors flex items-center gap-2"
              >
                <Stop size={17} weight="fill" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!canSubmit}
                className="h-10 px-4 accent-button rounded-lg disabled:opacity-40 transition-colors flex items-center gap-2"
              >
                <PaperPlaneRight size={17} weight="fill" />
                Send
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function AssistantBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-chat-role={isUser ? 'user' : 'assistant'}
        className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm ${
          isUser
            ? 'chat-request-bubble'
            : 'surface-glass border border-subtle text-primary'
        }`}
      >
        {isUser && message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 grid grid-cols-2 gap-2">
            {message.attachments.map((attachment, index) => (
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
                  <span className="mr-2 rounded-sm border border-subtle px-1.5 py-0.5 text-[10px] uppercase text-muted">
                    {fileExtensionLabel(attachment.name)}
                  </span>
                  <span>{attachment.name}</span>
                </div>
              )
            ))}
          </div>
        )}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2">
            <ToolCallTimeline toolCalls={message.toolCalls as any} detailsExpanded={false} />
          </div>
        )}
        <p className="whitespace-pre-wrap">{message.content || (message.isStreaming ? 'Running...' : '')}</p>
      </div>
    </div>
  );
}

function relativeUpdatedAt(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}
