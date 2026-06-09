import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatThread, ChatMessage, FileAttachment, Ask, AnswerSet, ToolCallInfo } from '@nexus/shared';
import { api, AgentStatus } from '../api';
import QuestionCard from './QuestionCard';
import { ThinkingBlock } from './ThinkingBlock';
import { ActivityBlock } from './ActivityBlock';
import { ToolCallTimeline } from './ToolCallTimeline';
import { Stop } from '@phosphor-icons/react';

interface ChatPanelProps {
  projectId: string;
  threadId: string | null;
  /** resolved agent status (provider + model), used to label the active thread's agent */
  agents?: AgentStatus[];
  /** persona slug for the active thread — lets the header label the agent without a thread list */
  agentSlug?: string;
  /** called after rename/delete (or a session-id/title change) so the tree (source of truth) reloads */
  onThreadsChanged?: () => void;
}

/** Read a File as base64 (without the data: URL prefix) for JSON upload. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ChatPanel({ projectId, threadId, agents, agentSlug, onThreadsChanged }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCopied, setSessionCopied] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  // Mirrors the active thread for async handlers: lets an in-flight send check it's
  // still on the same thread before writing results (guards against bleed when
  // the user switches threads mid-reply).
  const activeThreadId = threadId;
  const activeThreadIdRef = useRef<string | null>(null);
  useEffect(() => { activeThreadIdRef.current = activeThreadId; }, [activeThreadId]);

  // Ctrl+O toggles the details-expanded view (tool timeline, full thinking)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        setDetailsExpanded(v => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      setMessages(await api.chat.messages(id));
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }, []);

  useEffect(() => {
    setSessionId(null);
    if (threadId) loadMessages(threadId);
    else setMessages([]);
  }, [threadId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!activeThreadId) return;
    if (!input.trim() && attachments.length === 0) return;

    const threadId = activeThreadId;
    const content = input;
    const files = attachments;

    setInput('');
    setAttachments([]);
    setIsTyping(true);

    // Optimistically show the user's message while the agent runs (attachments
    // appear after the post-send refresh, once they're persisted).
    setMessages(prev => [
      ...prev,
      { id: `tmp-${Date.now()}`, thread_id: threadId, role: 'user', content, attachments_json: '[]', message_type: 'text', structured_json: null, created_at: new Date().toISOString() },
    ]);

    try {
      // Upload any queued files first (persists them under the project repo), then
      // send the turn referencing the saved attachments.
      let attachmentsJson = '[]';
      if (files.length > 0) {
        const payload = await Promise.all(files.map(async f => ({
          name: f.name,
          mime_type: f.type || 'application/octet-stream',
          data_base64: await fileToBase64(f),
        })));
        const saved = await api.chat.upload(threadId, payload);
        attachmentsJson = JSON.stringify(saved);
      }
      // Provisional assistant bubble that fills in as deltas stream.
      const provisionalId = `streaming-${Date.now()}`;
      const baseMsg = { id: provisionalId, thread_id: threadId, role: 'assistant' as const, content: '', attachments_json: '[]', message_type: 'text' as const, structured_json: null, thinking: '', tool_calls: [] as ToolCallInfo[], created_at: new Date().toISOString() };
      setMessages(prev => [...prev, baseMsg]);
      let acc = '';
      let thinkingAcc = '';
      const toolCallsMap = new Map<string, ToolCallInfo>();
      await api.chat.sendMessageStream(threadId, content, attachmentsJson, ev => {
        if (activeThreadIdRef.current !== threadId) return; // user navigated away — drop
        if (ev.kind === 'delta') {
          acc += ev.text;
          setMessages(prev => prev.map(m => (m.id === provisionalId ? { ...m, content: acc } : m)));
        } else if (ev.kind === 'thinking') {
          thinkingAcc += ev.text;
          setMessages(prev => prev.map(m => (m.id === provisionalId ? { ...m, thinking: thinkingAcc } : m)));
        } else if (ev.kind === 'tool_start') {
          toolCallsMap.set(ev.tool.id, { ...ev.tool });
          setMessages(prev => prev.map(m => (m.id === provisionalId ? { ...m, tool_calls: Array.from(toolCallsMap.values()) } : m)));
        } else if (ev.kind === 'tool_end') {
          toolCallsMap.set(ev.tool.id, { ...ev.tool });
          setMessages(prev => prev.map(m => (m.id === provisionalId ? { ...m, tool_calls: Array.from(toolCallsMap.values()) } : m)));
        } else if (ev.kind === 'tool_update') {
          const existing = toolCallsMap.get(ev.id);
          if (existing) {
            Object.assign(existing, ev.patch);
            setMessages(prev => prev.map(m => (m.id === provisionalId ? { ...m, tool_calls: Array.from(toolCallsMap.values()) } : m)));
          }
        } else if (ev.kind === 'session') {
          setSessionId(ev.session_id);
        } else if (ev.kind === 'error') {
          acc = `[error] ${ev.error}`;
          setMessages(prev => prev.map(m => (m.id === provisionalId ? { ...m, content: acc } : m)));
        }
        // 'done' → finalize from the DB below (renders question cards, attachments, etc.)
      });
      // Replace the optimistic/provisional messages with the authoritative DB state.
      if (activeThreadIdRef.current === threadId) {
        await loadMessages(threadId);
        // The turn may have captured a session id or auto-titled the thread —
        // ask the tree (source of truth for the thread list) to refresh.
        onThreadsChanged?.();
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Queue the picked/dropped files; the actual upload happens at send-time (once
  // we have a thread → project → repo path to save them under).
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    setAttachments(prev => [...prev, ...Array.from(e.target.files!)]);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setAttachments(prev => [...prev, ...Array.from(e.dataTransfer.files)]);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const activeAgent = agentSlug ? agents?.find(a => a.slug === agentSlug) : undefined;
  const activeAgentName = activeAgent?.name ?? agentSlug ?? '';

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      {activeThreadId ? (
        <>
          {/* Who you're talking to */}
          {activeAgentName && (
            <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3">
              <span className="text-sm text-zinc-200 flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                <span className="truncate">{activeAgentName}</span>
                {activeAgent && (
                  <span className="text-[10px] text-zinc-500 shrink-0 truncate">
                    {activeAgent.provider} · {activeAgent.model || 'provider default'}
                  </span>
                )}
              </span>
            </div>
          )}

          {/* Resume chip: the latest Claude Code session id for this thread.
              Copy gives the exact `claude --resume <id>` command to pick the
              conversation back up in a terminal if a turn stalls. */}
          {sessionId && (
            <div className="px-4 py-1.5 border-b border-zinc-800/50 flex items-center gap-2 text-[11px] text-zinc-500">
              <span className="shrink-0">Claude session</span>
              <code className="text-zinc-400 truncate font-mono" title={sessionId}>
                {sessionId}
              </code>
              {/* Note: the osascript "Open terminal" button was removed now that
                  Nexus has in-app terminal threads. The backend route
                  (/api/threads/:id/open-terminal) and api.chat.openTerminal binding
                  are intentionally retained in case we re-surface this affordance. */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`claude --resume ${sessionId}`);
                  setSessionCopied(true);
                  setTimeout(() => setSessionCopied(false), 1500);
                }}
                className="ml-auto shrink-0 px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors"
                title="Copy `claude --resume <id>` to run in a terminal"
              >
                {sessionCopied ? 'Copied ✓' : 'Copy resume'}
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, idx) => {
              if (msg.message_type === 'question' && msg.structured_json) {
                const ask = JSON.parse(msg.structured_json) as Ask;
                // A question is open only while it is the last message in the thread.
                const isLast = idx === messages.length - 1;
                const nextMsg = messages[idx + 1];
                const answeredReplies = nextMsg && nextMsg.message_type === 'answer' && nextMsg.structured_json
                  ? (JSON.parse(nextMsg.structured_json) as AnswerSet).replies
                  : undefined;
                return (
                  <div key={msg.id} className="flex justify-start">
                    <QuestionCard
                      ask={ask}
                      preamble={msg.content}
                      threadId={activeThreadId}
                      questionMessageId={msg.id}
                      answered={!isLast}
                      answeredReplies={answeredReplies}
                      onAnswered={() => loadMessages(activeThreadId)}
                    />
                  </div>
                );
              }
              // 'answer' messages are already shown highlighted within the
              // preceding QuestionCard's read-only state — skip the echoed bubble.
              if (msg.message_type === 'answer') return null;
              return (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm ${msg.role === 'user' ? 'bg-indigo-500 text-ink' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'}`}>
                    {msg.attachments_json && msg.attachments_json !== '[]' && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {JSON.parse(msg.attachments_json).map((a: FileAttachment, i: number) => (
                          <span key={i} className="text-xs bg-white/10 px-2 py-0.5 rounded truncate max-w-[200px]">
                            📎 {a.original_name}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              );
            })}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2 text-sm text-zinc-500">
                  <span className="animate-pulse">Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Drop zone & composer */}
          <div className="border-t border-zinc-800 p-3 space-y-2">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {attachments.map((a, i) => (
                  <span key={i} className="flex items-center gap-1 text-xs bg-zinc-800/50 px-2 py-1 rounded text-zinc-200">
                    📎 {a.name}
                    <button onClick={() => removeAttachment(i)} className="text-zinc-500 hover:text-red-400 ml-1">✕</button>
                  </span>
                ))}
              </div>
            )}

            <div
              ref={dropZoneRef}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg px-4 py-3 text-center text-xs cursor-pointer transition-colors ${dragOver ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-zinc-800 text-zinc-500 hover:border-indigo-500/50'}`}
            >
              {dragOver ? 'Drop files here' : 'Drop files here or click to attach'}
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
            </div>

            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                rows={2}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600/50 resize-none focus:outline-none focus:border-indigo-500/50"
              />
              {isTyping && (
                <button
                  type="button"
                  onClick={async () => {
                    try { await api.chat.abort(threadId); } catch { /* ignore */ }
                  }}
                  className="px-3 bg-zinc-700 text-zinc-300 rounded-lg hover:bg-zinc-600 transition-colors self-end"
                  title="Stop the current generation"
                >
                  <Stop className="w-5 h-5" weight="fill" />
                </button>
              )}
              <button
                onClick={handleSend}
                disabled={(!input.trim() && attachments.length === 0) || isTyping}
                className="px-4 bg-indigo-500 text-ink rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors self-end"
              >
                Send
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-zinc-500 text-sm">Select a conversation, or use “+ New” in the tree to start one.</p>
          </div>
        </div>
      )}
    </div>
  );
}
