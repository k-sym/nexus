import { useState } from 'react';
import type { AgentRunView } from '../chat/agent-run-state';
import type { QuestionAnswer, QuestionToolResult } from '../lib/questions';
import { AgentRunHeader } from './AgentRunHeader';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallTimeline, QuestionCards } from './ToolCallTimeline';

interface AgentRunCardProps {
  run: AgentRunView;
  content: string;
  thinking?: string | null;
  detailsExpanded: boolean;
  /** When true, this is the latest assistant response in the thread. A
   *  completed latest run stays expanded so the user can see what they're
   *  replying to; it collapses once the user sends a reply (isLatest becomes
   *  false). The user's manual toggle is always respected. (issue #108) */
  isLatest?: boolean;
  onStop: () => void;
  questionState?: Record<string, { submitting?: boolean; error?: string; result?: QuestionToolResult }>;
  onAnswerQuestion?: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
}

function runSummary(run: AgentRunView): string {
  const count = run.tools.length;
  const failed = run.tools.filter((tool) => tool.status === 'failed').length;
  const interrupted = run.tools.filter((tool) => tool.status === 'interrupted' || tool.status === 'cancelled').length;
  const parts = [`${count} tool call${count === 1 ? '' : 's'}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (interrupted > 0) parts.push(`${interrupted} interrupted`);
  return parts.join(' · ');
}

export function AgentRunCard({
  run,
  content,
  thinking,
  detailsExpanded,
  isLatest = false,
  onStop,
  questionState,
  onAnswerQuestion,
}: AgentRunCardProps) {
  // Expansion model (issue #108): a run auto-expands while running, when it
  // ended badly (failed/cancelled/interrupted), or when it's the latest
  // assistant response the user is replying to. The user's manual toggle is
  // captured as an override that always wins over the auto state, so once
  // they explicitly open/close a card it stays that way.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const autoExpanded =
    run.status === 'running' ||
    run.status === 'failed' ||
    run.status === 'cancelled' ||
    run.status === 'interrupted' ||
    isLatest;
  const expanded = userOverride ?? (autoExpanded || detailsExpanded);

  return (
    <section className="agent-run-card w-full max-w-[88%] overflow-hidden rounded-xl border border-subtle surface-glass text-primary">
      <AgentRunHeader
        run={run}
        expanded={expanded}
        onToggle={() => setUserOverride(!expanded)}
        onStop={onStop}
        summary={runSummary(run)}
      />
      {expanded && (
        <div className="space-y-2 px-3 py-2">
          <ToolCallTimeline
            toolCalls={run.tools}
            detailsExpanded={detailsExpanded}
          />
          {thinking && (
            <ThinkingBlock
              thinking={thinking}
              isThinking={run.status === 'running' && run.phase === 'model_responding'}
              expanded={detailsExpanded}
            />
          )}
          {content && <p className="whitespace-pre-wrap text-sm">{content}</p>}
          {run.error && run.status !== 'completed' && (
            <p className="text-xs text-red-300" role="alert">{run.error}</p>
          )}
          {/* Question cards render last, after the prelude text, so the ask
              sits at the bottom of the bubble next to where the user replies
              (issue #109). */}
          <QuestionCards
            toolCalls={run.tools}
            questionState={questionState}
            onAnswerQuestion={onAnswerQuestion}
          />
        </div>
      )}
    </section>
  );
}
