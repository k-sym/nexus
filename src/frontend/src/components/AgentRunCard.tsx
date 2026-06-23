import { useEffect, useState } from 'react';
import type { AgentRunView } from '../chat/agent-run-state';
import type { QuestionAnswer, QuestionToolResult } from '../lib/questions';
import { AgentRunHeader } from './AgentRunHeader';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallTimeline } from './ToolCallTimeline';

interface AgentRunCardProps {
  run: AgentRunView;
  content: string;
  thinking?: string | null;
  detailsExpanded: boolean;
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
  onStop,
  questionState,
  onAnswerQuestion,
}: AgentRunCardProps) {
  const [locallyExpanded, setLocallyExpanded] = useState(run.status !== 'completed');
  useEffect(() => {
    if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') {
      setLocallyExpanded(true);
    }
  }, [run.status]);
  const expanded = run.status === 'running' || detailsExpanded || locallyExpanded;

  return (
    <section className="agent-run-card w-full max-w-[88%] overflow-hidden rounded-xl border border-subtle surface-glass text-primary">
      <AgentRunHeader
        run={run}
        expanded={expanded}
        onToggle={() => setLocallyExpanded((value) => !value)}
        onStop={onStop}
        summary={runSummary(run)}
      />
      {expanded && (
        <div className="space-y-2 px-3 py-2">
          <ToolCallTimeline
            toolCalls={run.tools}
            detailsExpanded={detailsExpanded}
            questionState={questionState}
            onAnswerQuestion={onAnswerQuestion}
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
        </div>
      )}
    </section>
  );
}
