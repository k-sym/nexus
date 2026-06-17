import { useCallback, useEffect, useState } from 'react';
import { Stop } from '@phosphor-icons/react';
import { AssistantMessage, useAssistantStream } from '../hooks/useAssistantStream';

export default function AssistantView() {
  const { messages, isRunning, error, loadThread, send, abort } = useAssistantStream();
  const [input, setInput] = useState('');

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning) return;
    const sent = await send(text);
    if (sent) setInput('');
  }, [input, isRunning, send]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="surface-glass flex items-center justify-between px-6 py-3 border-b border-subtle shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Assistant</h1>
          <p className="text-xs text-faint">Global remote assistant</p>
        </div>
        <span className="text-xs text-faint uppercase tracking-wider">Project independent</span>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 ? (
          <p className="text-faint text-sm">Send a message to start.</p>
        ) : (
          messages.map((message) => <AssistantBubble key={message.id} message={message} />)
        )}
      </div>

      {error && (
        <div className="px-4 py-2 border-t border-subtle text-xs text-red-300" role="alert">
          {error}
        </div>
      )}

      <div className="border-t border-subtle surface-glass p-3">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Assistant..."
            rows={2}
            className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong"
          />
          {isRunning ? (
            <button
              type="button"
              onClick={() => void abort()}
              className="px-3 py-2 surface-elevated text-muted rounded-lg hover:text-[var(--text-primary)] transition-colors"
              title="Stop the current Assistant response"
            >
              <Stop className="w-5 h-5" weight="fill" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!input.trim()}
              className="px-4 py-2 accent-button rounded-lg disabled:opacity-40 transition-colors"
            >
              Send
            </button>
          )}
        </div>
      </div>
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
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}
