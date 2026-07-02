import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowsClockwise, CloudArrowUp, PaperPlaneRight, Paperclip, PencilSimple, Plus, Stop, Trash, X } from '@phosphor-icons/react';
import {
  AssistantAttachment,
  AssistantMessage,
  AssistantSession,
  useAssistantStream,
} from '../hooks/useAssistantStream';
import { confirmDialog } from '../lib/confirm';
import { AgentRunCard } from './AgentRunCard';
import { RunStatusStrip } from './RunStatusStrip';

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

export default function AssistantView() {
  const {
    sessions,
    selectedSession,
    selectedSessionId,
    messages,
    latestRun,
    isRunning,
    error,
    loadSessions,
    loadSession,
    createSession,
    renameSession,
    send,
    startBackgroundRun,
    sync,
    abort,
    clear,
  } = useAssistantStream();
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<AssistantAttachment[]>([]);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSelectedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!renaming) setRenameDraft(selectedSession?.title ?? '');
  }, [renaming, selectedSession?.title]);

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
      const created = await createSession();
      if (created) setInput('');
      return;
    }
    if (text === '/clear' && pendingAttachments.length === 0) {
      if (!(await confirmDialog('Delete this Assistant session? This cannot be undone.'))) return;
      const cleared = await clear();
      if (cleared) setInput('');
      return;
    }
    if (isRunning) return;
    const sent = await send(text, pendingAttachments);
    if (sent) {
      setInput('');
      setPendingAttachments([]);
      setAttachmentWarning(null);
    }
  }, [clear, createSession, input, isRunning, pendingAttachments, selectedSessionId, send]);

  const handleBackgroundRun = useCallback(async () => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || !selectedSessionId) return;
    const started = await startBackgroundRun(text, pendingAttachments);
    if (started) {
      setInput('');
      setPendingAttachments([]);
      setAttachmentWarning(null);
    }
  }, [input, pendingAttachments, selectedSessionId, startBackgroundRun]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const commitRename = useCallback(async () => {
    if (!selectedSessionId) return;
    const renamed = await renameSession(selectedSessionId, renameDraft);
    if (renamed) setRenaming(false);
  }, [renameDraft, renameSession, selectedSessionId]);

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

  const removePendingAttachment = useCallback((index: number) => {
    setPendingAttachments((current) => current.filter((_, i) => i !== index));
    setAttachmentWarning(null);
  }, []);

  const trimmedInput = input.trim();
  const canSubmit = !!selectedSessionId && (!!trimmedInput || pendingAttachments.length > 0);

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
      <aside className="w-72 shrink-0 surface-glass border-r border-subtle flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-subtle flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Assistant</h1>
            <p className="text-xs text-faint">Sessions</p>
          </div>
          <button
            type="button"
            onClick={() => void createSession()}
            className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
            title="New Assistant session"
            aria-label="New Session"
          >
            <Plus size={16} weight="bold" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-sm text-faint">No Assistant sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === selectedSessionId}
                onSelect={() => void loadSession(session.id)}
              />
            ))
          )}
        </div>
      </aside>

      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="surface-glass flex items-center justify-between px-6 py-3 border-b border-subtle shrink-0">
          <div className="min-w-0">
            {renaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(false);
                  }
                }}
                className="surface-elevated text-primary text-lg font-semibold px-2 py-0.5 rounded outline-none ring-1 ring-[var(--accent)]"
              />
            ) : (
              <h2 className="text-lg font-semibold truncate">{selectedSession?.title ?? 'Assistant'}</h2>
            )}
            {latestRun?.remote_run_id && (
              <div className="flex items-center gap-2 text-xs text-faint">
                <span className="truncate">remote {latestRun.remote_run_id}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setRenameDraft(selectedSession?.title ?? '');
                setRenaming(true);
              }}
              disabled={!selectedSessionId}
              className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors disabled:opacity-40"
              title="Rename Assistant session"
              aria-label="Rename Assistant session"
            >
              <PencilSimple size={16} />
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!selectedSessionId}
              className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-red-300 hover:border-strong transition-colors disabled:opacity-40"
              title="Delete Assistant session"
              aria-label="Delete Assistant session"
            >
              <Trash size={16} />
            </button>
            <button
              type="button"
              onClick={() => void sync()}
              className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
              title="Sync Assistant sessions"
              aria-label="Sync"
            >
              <ArrowsClockwise size={16} />
            </button>
          </div>
        </header>

        {confirmingDelete && selectedSessionId && (
          <div
            role="alertdialog"
            aria-label="Confirm delete Assistant session"
            className="surface-panel border-b border-subtle px-6 py-2 flex items-center justify-end gap-2 text-xs text-muted"
          >
            <span className="mr-auto text-primary">Delete this Assistant session?</span>
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
                if (cleared) setConfirmingDelete(false);
              }}
              className="h-8 px-3 rounded-lg border border-red-400/35 text-red-200 bg-red-950/35 hover:border-red-300 transition-colors"
              aria-label="Confirm delete Assistant session"
            >
              Delete
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <p className="text-faint text-sm">Send a message to start.</p>
          ) : (
            messages.map((message) =>
              message.role !== 'user' && message.run ? (
                <div key={message.id} className="flex justify-start">
                  <AgentRunCard
                    run={message.run}
                    content={message.content}
                    thinking={message.thinking}
                    detailsExpanded={false}
                  />
                </div>
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
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length === 0) return;
                e.preventDefault();
                void addAttachmentFiles(files);
              }}
              placeholder="Message Assistant..."
              rows={2}
              disabled={!selectedSessionId}
              className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void handleBackgroundRun()}
              disabled={!canSubmit}
              className="h-10 px-3 surface-elevated border border-subtle rounded-lg flex items-center gap-2 text-sm text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Hand this run off to keep it running in the background after Nexus restarts"
            >
              <CloudArrowUp size={17} />
              Background Handoff
            </button>
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

function SessionRow({ session, selected, onSelect }: { session: AssistantSession; selected: boolean; onSelect: () => void }) {
  const active = session.status === 'running' || session.latestRun?.status === 'running';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg px-3 py-2 border transition-colors ${
        selected
          ? 'surface-elevated border-strong text-primary'
          : 'border-transparent text-muted hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-[var(--border-strong)]'}`} aria-hidden="true" />
        <span className="text-sm font-medium truncate">{session.title}</span>
      </div>
      {session.updated_at && (
        <div className="text-[11px] text-faint mt-1 truncate">{relativeUpdatedAt(session.updated_at)}</div>
      )}
    </button>
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
                  <span className="mr-2 rounded border border-subtle px-1.5 py-0.5 text-[10px] uppercase text-muted">
                    {fileExtensionLabel(attachment.name)}
                  </span>
                  <span>{attachment.name}</span>
                </div>
              )
            ))}
          </div>
        )}
        <p className="whitespace-pre-wrap">{message.content || (message.isStreaming ? 'Running...' : '')}</p>
      </div>
    </div>
  );
}

function AttachmentChip({
  attachment,
  index,
  onRemove,
}: {
  attachment: AssistantAttachment;
  index: number;
  onRemove: (index: number) => void;
}) {
  return (
    <div
      data-testid="pending-assistant-attachment"
      className={`relative rounded-md overflow-hidden border border-subtle surface-elevated shrink-0 ${
        attachment.type === 'image' ? 'w-20 h-16' : 'min-w-36 max-w-52 h-16 px-2 py-2'
      }`}
    >
      {attachment.type === 'image' ? (
        <img
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
        onClick={() => onRemove(index)}
        className="absolute right-1 top-1 w-5 h-5 rounded-full bg-zinc-950/85 text-xs text-primary flex items-center justify-center"
        aria-label={`Remove ${attachment.name ?? `attachment ${index + 1}`}`}
      >
        <X size={12} />
      </button>
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

function fileToAttachment(file: File): Promise<AssistantAttachment> {
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
      } as AssistantAttachment);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment.'));
    reader.readAsDataURL(file);
  });
}

function fileExtensionLabel(name?: string): string {
  if (!name || !name.includes('.')) return 'file';
  return name.split('.').pop()?.slice(0, 5) || 'file';
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
