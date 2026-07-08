import type { AgentRunView } from '../chat/agent-run-state';
import type { QuestionAnswer, QuestionToolResult } from '../lib/questions';
import { terminalLabel } from './runLabels';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolActivity, QuestionCards } from './ToolCallTimeline';
import ChatMessageContent from './ChatMessageContent';

interface AgentRunCardProps {
  run: AgentRunView;
  content: string;
  thinking?: string | null;
  detailsExpanded: boolean;
  questionState?: Record<string, { submitting?: boolean; error?: string; result?: QuestionToolResult }>;
  onAnswerQuestion?: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
  onOpenArtifact?: (path: string) => void;
}

export function AgentRunCard({
  run,
  content,
  thinking,
  detailsExpanded,
  questionState,
  onAnswerQuestion,
  onOpenArtifact,
}: AgentRunCardProps) {
  const running = run.status === 'running';

  const toolActivity = (
    <ToolActivity
      toolCalls={run.tools}
      running={running}
      detailsExpanded={detailsExpanded}
      terminalLabel={running ? undefined : terminalLabel(run)}
    />
  );

  const thinkingBlock = thinking ? (
    <ThinkingBlock
      thinking={thinking}
      isThinking={running && run.phase === 'model_responding'}
      expanded={detailsExpanded}
    />
  ) : null;

  const contentBlock = content ? (
    <div className="text-sm">
      {onOpenArtifact ? <ChatMessageContent text={content} onOpenPath={onOpenArtifact} /> : content}
    </div>
  ) : null;

  return (
    <section className="agent-run-card w-full max-w-[88%] space-y-2 overflow-hidden rounded-xl border border-subtle surface-glass px-3 py-2 text-primary">
      {/* Running: show live tool activity first, then the emerging text. Finished:
          lead with the model's text and tuck tool detail into the summary below
          (issue: keep model output on screen; header removed). */}
      {running ? (
        <>
          {toolActivity}
          {thinkingBlock}
          {contentBlock}
        </>
      ) : (
        <>
          {thinkingBlock}
          {contentBlock}
          {toolActivity}
        </>
      )}
      {run.error && run.status !== 'completed' && (
        <p className="text-xs text-red-300" role="alert">{run.error}</p>
      )}
      {/* Question cards render last so the ask sits at the bottom of the bubble
          next to where the user replies (issue #109). */}
      <QuestionCards
        toolCalls={run.tools}
        questionState={questionState}
        onAnswerQuestion={onAnswerQuestion}
      />
    </section>
  );
}
