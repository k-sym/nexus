import type { ResolvedSignalFilterConfig } from './config.js';
import {
  filterSignal,
  type SignalFilterContext,
  type SignalFilterResult,
  type SignalFilterStats,
} from './pipeline.js';

interface TextBlock { type: 'text'; text: string }

export interface SignalProjection {
  rawText: string;
  filteredText: string;
  stats: SignalFilterStats;
  appliedFilters: string[];
  context: SignalFilterContext;
}

export interface MessageProjection<T = unknown> {
  messages: T[];
  resultsByToolCallId: Map<string, SignalProjection>;
}

interface ProjectionDeps {
  filter?: typeof filterSignal;
}

export function projectToolResultMessages<T>(
  messages: T[],
  _repoPath: string,
  config: ResolvedSignalFilterConfig,
  deps: ProjectionDeps = {},
): MessageProjection<T> {
  const runFilter = deps.filter ?? filterSignal;
  const commands = collectToolCommands(messages);
  const resultsByToolCallId = new Map<string, SignalProjection>();

  const projected = messages.map((original) => {
    const message = original as any;
    if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return original;
    const textBlocks = message.content.filter(isTextBlock) as TextBlock[];
    if (textBlocks.length === 0) return original;

    const rawText = textBlocks.map((block) => block.text).join('');
    const context: SignalFilterContext = {
      toolName: String(message.toolName ?? 'unknown'),
      command: commands.get(String(message.toolCallId)),
      isError: Boolean(message.isError),
    };
    let filtered: SignalFilterResult;
    try {
      filtered = runFilter(rawText, context, config);
    } catch {
      filtered = rawProjection(rawText);
    }
    resultsByToolCallId.set(String(message.toolCallId), {
      rawText,
      filteredText: filtered.text,
      stats: filtered.stats,
      appliedFilters: filtered.appliedFilters,
      context,
    });
    if (filtered.text === rawText) return original;

    let wroteText = false;
    const content = message.content.map((block: any) => {
      if (!isTextBlock(block)) return block;
      if (!wroteText) {
        wroteText = true;
        return { ...block, text: filtered.text };
      }
      return { ...block, text: '' };
    });
    return { ...message, content } as T;
  });

  return { messages: projected, resultsByToolCallId };
}

function collectToolCommands<T>(messages: T[]): Map<string, string> {
  const commands = new Map<string, string>();
  for (const source of messages as any[]) {
    if (source?.role !== 'assistant' || !Array.isArray(source.content)) continue;
    for (const block of source.content) {
      if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
      const command = block.arguments?.command;
      if (typeof command === 'string' && command.trim()) commands.set(block.id, command);
    }
  }
  return commands;
}

function isTextBlock(value: unknown): value is TextBlock {
  return Boolean(value && typeof value === 'object' && (value as any).type === 'text' && typeof (value as any).text === 'string');
}

function rawProjection(text: string): SignalFilterResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text === '' ? 0 : text.split('\n').length;
  return {
    text,
    stats: { inputBytes: bytes, outputBytes: bytes, inputLines: lines, outputLines: lines },
    appliedFilters: [],
  };
}
