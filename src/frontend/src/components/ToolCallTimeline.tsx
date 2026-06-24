import { WarningCircle, Check, Circle, Prohibit, Spinner } from '@phosphor-icons/react';
import { useState } from 'react';
import { QuestionCard } from './QuestionCard';
import { normalizeQuestionRequest, parseQuestionResult, type QuestionAnswer, type QuestionToolResult } from '../lib/questions';

/** Local copy of the tool-call shape produced by the pi runtime's event
 *  stream. The shared types module used to export this; since it was
 *  legacy and got dropped, we declare it locally with a slightly wider
 *  shape (pi can emit status, args, result with more nuanced types). */
export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'completed' | 'error';
  result?: string;
  is_error?: boolean;
  details?: unknown;
  partial_output?: string;
  partialOutput?: string;
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  payloadBytes?: number;
}

interface ToolCallTimelineProps {
  toolCalls: ToolCallInfo[];
  detailsExpanded?: boolean;
  questionState?: Record<string, { submitting?: boolean; error?: string; result?: QuestionToolResult }>;
  onAnswerQuestion?: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
}

/** Whether a tool call is a structured question (rendered as a QuestionCard). */
export function isQuestionTool(tc: ToolCallInfo): boolean {
  return tc.name === 'question' && !!normalizeQuestionRequest(tc.args);
}

export function ToolCallTimeline({ toolCalls, detailsExpanded, questionState, onAnswerQuestion }: ToolCallTimelineProps) {
  // Question tools are rendered separately (via <QuestionCards />) so they can
  // be placed at the bottom of the bubble — after the assistant's prelude text
  // — rather than above it (issue #109).
  const nonQuestionTools = toolCalls.filter((tc) => !isQuestionTool(tc));
  if (nonQuestionTools.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 my-1.5">
      {nonQuestionTools.map((tc) => (
        <ToolCallBlock key={tc.id} toolCall={tc} detailsExpanded={detailsExpanded} />
      ))}
    </div>
  );
}

interface QuestionCardsProps {
  toolCalls: ToolCallInfo[];
  questionState?: Record<string, { submitting?: boolean; error?: string; result?: QuestionToolResult }>;
  onAnswerQuestion?: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
}

/** Render only the question tool calls as QuestionCards. Intended to be placed
 *  at the bottom of a chat bubble, after the assistant's prelude text. */
export function QuestionCards({ toolCalls, questionState, onAnswerQuestion }: QuestionCardsProps) {
  const questionTools = toolCalls.filter(isQuestionTool);
  if (questionTools.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 mt-2">
      {questionTools.map((tc) => {
        const request = normalizeQuestionRequest(tc.args);
        if (!request) return null;
        const state = questionState?.[tc.id];
        const result = state?.result ?? parseQuestionResult(tc.details) ?? parseQuestionResult(tc.result);
        return (
          <QuestionCard
            key={tc.id}
            request={request}
            answeredResult={result ?? undefined}
            unavailable={tc.status === 'interrupted' || tc.status === 'cancelled' || tc.status === 'failed' || tc.status === 'error' || ((tc.status === 'completed' || tc.status === 'succeeded') && !result)}
            submitting={state?.submitting}
            error={state?.error}
            onSubmit={(answers) => onAnswerQuestion?.(tc.id, answers) ?? Promise.resolve()}
          />
        );
      })}
    </div>
  );
}

function ToolCallBlock({
  toolCall,
  detailsExpanded,
}: { toolCall: ToolCallInfo; detailsExpanded?: boolean }) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isRunning = toolCall.status === 'running';
  const isQueued = toolCall.status === 'queued';
  const isError = toolCall.status === 'error' || toolCall.status === 'failed';
  const isInterrupted = toolCall.status === 'interrupted' || toolCall.status === 'cancelled';
  const showContent = !!detailsExpanded || localExpanded;

  const accentColor = isRunning
    ? 'text-indigo-400'
    : isError
      ? 'text-red-400'
      : isInterrupted
        ? 'text-amber-300'
      : 'text-emerald-400';

  const borderColor = isRunning
    ? 'border-indigo-500/30'
    : isError
      ? 'border-red-500/30'
      : isInterrupted
        ? 'border-amber-500/30'
      : 'border-zinc-700/50';

  const { header, statusLine } = buildHeader(toolCall);

  return (
    <div className={`text-xs font-mono border-l-2 ${borderColor} bg-zinc-900/40 rounded-r`}>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 w-full text-left cursor-pointer select-none"
        onClick={() => setLocalExpanded(!localExpanded)}
        aria-expanded={showContent}
      >
        {isQueued ? (
          <Circle className="w-3 h-3 flex-shrink-0 text-zinc-500" />
        ) : isRunning ? (
          <Spinner className={`w-3 h-3 animate-spin flex-shrink-0 ${accentColor}`} />
        ) : isError ? (
          <WarningCircle className={`w-3 h-3 flex-shrink-0 ${accentColor}`} />
        ) : isInterrupted ? (
          <Prohibit className={`w-3 h-3 flex-shrink-0 ${accentColor}`} />
        ) : (
          <Check className={`w-3 h-3 flex-shrink-0 ${accentColor}`} />
        )}
        <span className="text-zinc-300 flex-1 truncate" title={header}>{header}</span>
        <span className={`text-[10px] ${accentColor}`}>{toolStatusLabel(toolCall.status)}</span>
        {formatToolDuration(toolCall) && (
          <span className="text-[10px] text-zinc-600">{formatToolDuration(toolCall)}</span>
        )}
        {!showContent && !isRunning && (
          <span className="text-[10px] text-zinc-600 flex-shrink-0">Ctrl+O</span>
        )}
      </button>

      {statusLine && <div className="px-2 pb-1 text-zinc-500">{statusLine}</div>}

      {showContent && (
        <div className="px-2 pb-1.5">
          <ToolContent toolCall={toolCall} />
        </div>
      )}
    </div>
  );
}

function toolStatusLabel(status: ToolCallInfo['status']): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'running': return 'Running';
    case 'failed':
    case 'error': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Interrupted';
    default: return 'Succeeded';
  }
}

function buildHeader(tc: ToolCallInfo): { header: string; statusLine?: string } {
  const args = tc.args as Record<string, unknown>;

  switch (tc.name) {
    case 'Write': {
      const path = str(args.path) || str(args.file_path) || '';
      const content = str(args.content) || '';
      const lines = content.split('\n').length;
      const size = formatSize(new Blob([content]).size);
      const details = tc.details as Record<string, unknown> | undefined;
      const diffText = typeof details?.diff === 'string' ? details.diff : tc.result || '';
      const isNewFile = diffText.includes('--- /dev/null');
      const action = isNewFile ? 'created' : 'overwritten';
      return {
        header: `write ${shortenPath(path)} (${lines} lines · ${size})`,
        statusLine: tc.status === 'completed' || tc.status === 'succeeded' ? `└ ${action}` : undefined,
      };
    }

    case 'Edit': {
      const path = str(args.path) || str(args.file_path) || '';
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const editLineCount = edits.reduce(
        (sum: number, e: Record<string, unknown>) => sum + countLines(str(e.newText) || ''),
        0,
      );
      const { added, removed } = diffStats(tc.result || '');
      const statParts: string[] = [];
      if (editLineCount > 0) statParts.push(`${editLineCount} lines`);
      if (added > 0 || removed > 0) statParts.push(`+${added} -${removed}`);
      return {
        header: `editing ${shortenPath(path)}${statParts.length > 0 ? ` (${statParts.join(' · ')})` : ''}`,
        statusLine: tc.status === 'completed' || tc.status === 'succeeded'
          ? `└ diff ${added > 0 || removed > 0 ? `+${added} -${removed}` : 'applied'}`
          : undefined,
      };
    }

    case 'Read': {
      const path = str(args.path) || str(args.file_path) || '';
      const offset = num(args.offset);
      const limit = num(args.limit);
      let range = '';
      if (offset || limit) {
        const from = offset ?? 1;
        const to = limit ? from + limit - 1 : undefined;
        range = `:${from}${to ? `-${to}` : ''}`;
      }
      return { header: `read ${shortenPath(path)}${range}` };
    }

    case 'Bash': {
      const cmd = str(args.command) || '';
      const display = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
      return { header: `bash $ ${display}` };
    }

    case 'Grep': {
      const pattern = str(args.pattern) || '';
      const scope = shortenPath(str(args.path) || '.');
      return { header: `grep /${pattern}/ in ${scope}` };
    }

    case 'Find': {
      const pattern = str(args.pattern) || '';
      const scope = shortenPath(str(args.path) || '.');
      return { header: `find ${pattern} in ${scope}` };
    }

    case 'LS': {
      const path = shortenPath(str(args.path) || '.');
      return { header: `ls ${path}` };
    }

    case 'WebSearch': {
      const q = str(args.query) || '';
      return { header: `web_search ${q.slice(0, 80)}` };
    }

    case 'CodeSearch': {
      const q = str(args.query) || '';
      return { header: `code_search ${q.slice(0, 80)}` };
    }

    case 'FetchContent': {
      const url = str(args.url) || '';
      return { header: `fetch ${url.slice(0, 80)}` };
    }

    default: {
      const name = tc.name || 'unknown';
      const argSummary = Object.entries(args).slice(0, 2).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`).join(' ');
      return { header: argSummary ? `${name} (${argSummary})` : name };
    }
  }
}

function ToolContent({ toolCall }: { toolCall: ToolCallInfo }) {
  const isRunning = toolCall.status === 'running';

  if (isRunning) {
    const partialOutput = toolCall.partialOutput ?? toolCall.partial_output;
    if (partialOutput) {
      return <TruncatedOutput text={partialOutput} limit={800} />;
    }
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
        <span>{runningLabel(toolCall.name)}</span>
      </div>
    );
  }

  if (toolCall.result === undefined || toolCall.result === '') return null;

  if (toolCall.name === 'Edit' || toolCall.name === 'Write') {
    const details = toolCall.details as Record<string, unknown> | undefined;
    const diffText = typeof details?.diff === 'string' ? details.diff : '';
    if (diffText && isDiff(diffText)) {
      return <SplitDiff diffText={diffText} />;
    }
    if (toolCall.result) {
      return <TruncatedOutput text={toolCall.result} limit={2000} />;
    }
  }

  if (toolCall.name === 'Read') return null;

  if (toolCall.name === 'Bash' && (toolCall.status === 'error' || toolCall.status === 'failed')) {
    return (
      <pre className="text-[11px] whitespace-pre-wrap text-red-400">
        {truncate(toolCall.result, 3000)}
      </pre>
    );
  }

  return <TruncatedOutput text={toolCall.result} limit={2000} />;
}

function formatToolDuration(toolCall: ToolCallInfo): string | null {
  if (!toolCall.startedAt) return null;
  const end = toolCall.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - toolCall.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function runningLabel(name?: string): string {
  switch (name) {
    case 'Write': return 'Writing…';
    case 'Edit': return 'Editing…';
    case 'Read': return 'Reading…';
    case 'Bash': return 'Running command…';
    case 'Grep': return 'Searching…';
    case 'WebSearch': return 'Searching web…';
    case 'CodeSearch': return 'Searching code…';
    case 'FetchContent': return 'Fetching…';
    case 'Find': return 'Finding files…';
    case 'LS': return 'Listing…';
    default: return name ? `${name}…` : 'Working…';
  }
}

function TruncatedOutput({ text, limit }: { text: string; limit: number }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > limit;

  if (!needsTruncation || expanded) {
    return <pre className="text-[11px] whitespace-pre-wrap text-zinc-400/80">{text}</pre>;
  }

  const lines = text.split('\n');
  const truncated = lines.slice(0, 20).join('\n');
  const hiddenLines = lines.length - 20;

  return (
    <div>
      <pre className="text-[11px] whitespace-pre-wrap text-zinc-400/80">{truncated}</pre>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors mt-0.5"
      >
        {hiddenLines > 0
          ? `··· ${hiddenLines} more line${hiddenLines !== 1 ? 's' : ''} · Click to expand`
          : '··· Click to expand'}
      </button>
    </div>
  );
}

// ── Diff viewer ─────────────────────────────────────────────────────

interface DiffLine {
  oldNum: number | null;
  newNum: number | null;
  type: 'context' | 'add' | 'remove' | 'header' | 'hunk' | 'ellipsis';
  text: string;
}

function parseUnifiedDiff(diffText: string): { hunks: DiffLine[][]; isNewFile: boolean } {
  const lines = diffText.split('\n');
  const hunks: DiffLine[][] = [];
  let currentHunk: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let isNewFile = false;

  for (const line of lines) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (line.startsWith('--- ') && line.includes('/dev/null')) isNewFile = true;
      if (currentHunk.length > 0) { hunks.push(currentHunk); currentHunk = []; }
      currentHunk.push({ oldNum: null, newNum: null, type: 'header', text: line });
      continue;
    }
    if (line.startsWith('@@')) {
      if (currentHunk.length > 0 && currentHunk.some(l => l.type !== 'header')) {
        hunks.push(currentHunk); currentHunk = [];
      }
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = m ? Number.parseInt(m[1], 10) : 0;
      newLine = m ? Number.parseInt(m[2], 10) : 0;
      currentHunk.push({ oldNum: null, newNum: null, type: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      currentHunk.push({ oldNum: null, newNum: newLine++, type: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      currentHunk.push({ oldNum: oldLine++, newNum: null, type: 'remove', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      currentHunk.push({ oldNum: oldLine++, newNum: newLine++, type: 'context', text: line.slice(1) });
    } else if (line === '') {
      currentHunk.push({ oldNum: oldLine++, newNum: newLine++, type: 'context', text: '' });
    } else {
      currentHunk.push({ oldNum: null, newNum: null, type: 'context', text: line });
    }
  }
  if (currentHunk.length > 0) hunks.push(currentHunk);
  return { hunks: hunks.map(collapseContext), isNewFile };
}

function collapseContext(hunk: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let contextRun: DiffLine[] = [];
  for (const line of hunk) {
    if (line.type === 'context') {
      contextRun.push(line);
    } else {
      if (contextRun.length >= 4) {
        result.push(contextRun[0]);
        result.push({ oldNum: null, newNum: null, type: 'ellipsis', text: `··· ${contextRun.length - 2} lines ···` });
        result.push(contextRun[contextRun.length - 1]);
      } else {
        result.push(...contextRun);
      }
      contextRun = [];
      result.push(line);
    }
  }
  if (contextRun.length >= 4) {
    result.push(contextRun[0]);
    result.push({ oldNum: null, newNum: null, type: 'ellipsis', text: `··· ${contextRun.length - 2} lines ···` });
    result.push(contextRun[contextRun.length - 1]);
  } else {
    result.push(...contextRun);
  }
  return result;
}

function SplitDiff({ diffText }: { diffText: string }) {
  const { hunks, isNewFile } = parseUnifiedDiff(diffText);
  if (hunks.length === 0) return null;

  return (
    <div className="mt-1 overflow-x-auto">
      {hunks.map((hunk, hi) => (
        <div key={hi} className="min-w-[500px]">
          {hunk[0]?.type === 'hunk' && (
            <div className="text-[10px] text-zinc-600 py-0.5">{hunk[0].text}</div>
          )}
          <div className="grid" style={{ gridTemplateColumns: isNewFile ? '1fr' : '1fr 1fr' }}>
            {!isNewFile && (
              <>
                <div className="text-[10px] text-zinc-600 px-1 border-b border-zinc-800/30">old</div>
                <div className="text-[10px] text-zinc-600 px-1 border-b border-zinc-800/30">new</div>
              </>
            )}
            {isNewFile && (
              <div className="text-[10px] text-zinc-600 px-1 border-b border-zinc-800/30">new file</div>
            )}
            {hunk
              .filter(l => l.type !== 'header' && l.type !== 'hunk')
              .map((line, li) => (
                <DiffRow
                  key={`${line.oldNum ?? 'n'}-${line.newNum ?? 'n'}-${li}`}
                  line={line}
                  isNewFile={isNewFile}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffRow({ line, isNewFile }: { line: DiffLine; isNewFile: boolean }) {
  if (line.type === 'ellipsis') {
    return (
      <>
        {!isNewFile && <div className="px-1 py-0.5 text-zinc-700 text-center">{line.text}</div>}
        <div className={`px-1 py-0.5 text-zinc-700 text-center ${isNewFile ? 'col-span-2' : ''}`}>
          {line.text}
        </div>
      </>
    );
  }
  if (line.type === 'remove') {
    return (
      <>
        <div className="px-1 flex gap-1 bg-red-500/10 text-red-300">
          <span className="text-zinc-600 w-6 text-right flex-shrink-0">{line.oldNum}</span>
          <span className="truncate">{line.text || ' '}</span>
        </div>
        {!isNewFile && <div className="px-1 bg-red-500/10" />}
      </>
    );
  }
  if (line.type === 'add') {
    return (
      <>
        {!isNewFile && <div className="px-1 bg-emerald-500/10" />}
        <div className={`px-1 flex gap-1 bg-emerald-500/10 text-emerald-300 ${isNewFile ? 'col-span-2' : ''}`}>
          <span className="text-zinc-600 w-6 text-right flex-shrink-0">{line.newNum}</span>
          <span className="truncate">{line.text || ' '}</span>
        </div>
      </>
    );
  }
  return (
    <>
      {!isNewFile && (
        <div className="px-1 flex gap-1 text-zinc-500">
          <span className="text-zinc-600 w-6 text-right flex-shrink-0">{line.oldNum}</span>
          <span className="truncate">{line.text || ' '}</span>
        </div>
      )}
      <div className={`px-1 flex gap-1 text-zinc-500 ${isNewFile ? 'col-span-2' : ''}`}>
        <span className="text-zinc-600 w-6 text-right flex-shrink-0">{line.newNum}</span>
        <span className="truncate">{line.text || ' '}</span>
      </div>
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function shortenPath(path: string): string {
  if (!path) return '...';
  return path
    .replace(/^\/home\/[^/]+\//, '~/')
    .replace(/^\/Users\/[^/]+\//, '~/')
    .replace(/^C:\\Users\\[^/\\]+\\/, '~/');
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function diffStats(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function isDiff(text: string): boolean {
  return (
    text.includes('\n+') ||
    text.includes('\n-') ||
    text.includes('@@ ') ||
    text.includes('+++ ') ||
    text.includes('--- ')
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (${text.length - max} more chars)`;
}
