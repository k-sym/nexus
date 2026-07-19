import { useState } from 'react';

interface ThinkingBlockProps {
  thinking: string;
  isThinking: boolean;
  expanded?: boolean;
  simple?: boolean;
}

export function ThinkingBlock({ thinking, isThinking, expanded = false, simple = true }: ThinkingBlockProps) {
  const [localExpanded, setLocalExpanded] = useState(expanded);
  const showFull = !simple || localExpanded;

  if (!thinking && !isThinking) return null;

  if (!showFull) {
    const lastLine = thinking.split('\n').filter(Boolean).pop() ?? 'Thinking…';
    return (
      <button
        type="button"
        onClick={() => setLocalExpanded(true)}
        className="flex items-center gap-1.5 text-xs text-faint hover:text-[var(--text-muted)] transition-colors py-1"
      >
        {isThinking && <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-strong)] animate-pulse" />}
        <span className="italic truncate max-w-[400px]">{lastLine.slice(0, 200)}</span>
      </button>
    );
  }

  return (
    <details open={localExpanded} className="text-xs my-1.5 rounded-sm border border-subtle surface-panel">
      <summary
        className="cursor-pointer px-2 py-1 select-none flex items-center gap-1.5 list-none"
        onClick={(e) => { e.preventDefault(); setLocalExpanded(v => !v); }}
      >
        {isThinking && <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-strong)] animate-pulse" />}
        <span className="font-medium text-muted">Thinking</span>
        <span className="text-faint text-[10px]">· Ctrl+O</span>
      </summary>
      <div className="px-3 py-2 whitespace-pre-wrap text-muted max-h-64 overflow-y-auto font-mono text-[11px]">
        {thinking || '…'}
      </div>
    </details>
  );
}
