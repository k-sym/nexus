import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatThread, ChatMessage, FileAttachment } from '@nexus/shared';
import { api } from '../api';

interface ChatPanelProps {
  projectId: string;
}

export default function ChatPanel({ projectId }: ChatPanelProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('generalist');
  const [isTyping, setIsTyping] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const data = await api.chat.threads(projectId);
      setThreads(data);
      if (data.length > 0 && !activeThreadId) {
        setActiveThreadId(data[0].id);
      }
    } catch (err) {
      console.error('Failed to load threads:', err);
    }
  }, [projectId, activeThreadId]);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const data = await api.chat.messages(threadId);
      setMessages(data);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }, []);

  useEffect(() => {
    loadThreads();
  }, [projectId, loadThreads]);

  useEffect(() => {
    if (activeThreadId) {
      loadMessages(activeThreadId);
    } else {
      setMessages([]);
    }
  }, [activeThreadId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleNewThread = async () => {
    try {
      const thread = await api.chat.createThread(projectId, selectedAgent);
      setThreads(prev => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setMessages([]);
      setAttachments([]);
    } catch (err) {
      console.error('Failed to create thread:', err);
    }
  };

  const handleSend = async () => {
    if (!input.trim() && attachments.length === 0) return;
    if (!activeThreadId) {
      const thread = await api.chat.createThread(projectId, selectedAgent);
      setThreads(prev => [thread, ...prev]);
      setActiveThreadId(thread.id);
    }

    const threadId = activeThreadId || threads[0]?.id;
    if (!threadId) return;

    const content = input;
    const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : '[]';

    setInput('');
    setAttachments([]);
    setIsTyping(true);

    try {
      await api.chat.sendMessage(threadId, 'user', content, attachmentsJson);

      const assistantMsg = await api.chat.sendMessage(threadId, 'assistant', `I received your message: "${content}". This is a stub response — model integration coming in Phase 2.`);
      await loadMessages(threadId);

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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const filename = `${Date.now()}_${file.name}`;
      const attachment: FileAttachment = {
        filename,
        original_name: file.name,
        path: `/uploads/${filename}`,
        mime_type: file.type,
      };
      setAttachments(prev => [...prev, attachment]);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    for (const file of Array.from(files)) {
      const filename = `${Date.now()}_${file.name}`;
      const attachment: FileAttachment = {
        filename,
        original_name: file.name,
        path: `/uploads/${filename}`,
        mime_type: file.type || 'application/octet-stream',
      };
      setAttachments(prev => [...prev, attachment]);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="flex h-full">
      {/* Thread list sidebar */}
      <div className="w-52 border-r border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0">
        <div className="p-3 border-b border-zinc-800">
          <button
            onClick={handleNewThread}
            className="w-full px-3 py-1.5 bg-indigo-500 text-white text-sm rounded-md hover:bg-indigo-500 transition-colors"
          >
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads.map(thread => (
            <button
              key={thread.id}
              onClick={() => setActiveThreadId(thread.id)}
              className={`w-full text-left px-3 py-2 text-sm truncate border-b border-zinc-800/50 transition-colors ${activeThreadId === thread.id ? 'bg-indigo-500/20 text-white' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/20'}`}
            >
              {thread.title}
            </button>
          ))}
          {threads.length === 0 && (
            <div className="px-3 py-4 text-xs text-zinc-500 text-center">No conversations</div>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeThreadId ? (
          <>
            {/* Agent selector */}
            <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-3">
              <span className="text-xs text-zinc-500">Agent:</span>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 text-sm rounded px-2 py-1 text-zinc-200"
              >
                <option value="generalist">Generalist</option>
                <option value="developer">Developer</option>
                <option value="reviewer">Reviewer</option>
              </select>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] rounded-lg px-4 py-2 text-sm ${msg.role === 'user' ? 'bg-indigo-500 text-white' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'}`}>
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
              ))}
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
                      📎 {a.original_name}
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
                <button
                  onClick={handleSend}
                  disabled={!input.trim() && attachments.length === 0}
                  className="px-4 bg-indigo-500 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors self-end"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-zinc-500 text-sm mb-3">Select or start a conversation</p>
              <button
                onClick={handleNewThread}
                className="px-4 py-2 bg-indigo-500 text-white text-sm rounded-lg hover:bg-indigo-500 transition-colors"
              >
                Start Chat
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
