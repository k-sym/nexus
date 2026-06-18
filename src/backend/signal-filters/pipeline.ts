import type { ResolvedSignalFilterConfig } from './config.js';

export interface SignalFilterContext {
  toolName: string;
  command?: string;
  isError: boolean;
}

export interface SignalFilterStats {
  inputBytes: number;
  outputBytes: number;
  inputLines: number;
  outputLines: number;
}

export interface SignalFilterResult {
  text: string;
  stats: SignalFilterStats;
  appliedFilters: string[];
}

type Transform = (text: string, context: SignalFilterContext) => string;

const ANSI_PATTERN = /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const ERROR_PATTERN = /\b(?:error|fail(?:ed|ure)?|exception|assert(?:ion)?|fatal|panic|unhandled|timed?\s*out)\b/i;
const EXIT_PATTERN = /(?:command )?(?:exited|terminated|killed)(?: with)?(?: code| signal)?\s+\S+/i;
const FILE_REFERENCE_PATTERN = /(?:^|[\s(])(?:\.?\.?\/|[A-Za-z]:[\\/]|src\/|test\/|tests\/)[^\s():]+:\d+(?::\d+)?/;
const SUMMARY_PATTERN = /\b(?:tests?|test files?|suites?|passed|failed|skipped|duration|added|removed|audited|packages?|vulnerabilit(?:y|ies)|warnings?)\b.*\d|\d+.*\b(?:tests?|passed|failed|packages?|vulnerabilit(?:y|ies))\b/i;

export function filterSignal(
  input: string,
  context: SignalFilterContext,
  config: ResolvedSignalFilterConfig,
): SignalFilterResult {
  if (!config.enabled) return result(input, input, []);

  let text = input;
  const appliedFilters: string[] = [];
  const apply = (name: string, enabled: boolean, transform: Transform) => {
    if (!enabled) return;
    const next = transform(text, context);
    if (next !== text) {
      text = next;
      appliedFilters.push(name);
    }
  };

  apply('ansi', config.filters.ansi, cleanAnsiAndControls);
  apply('progress', config.filters.progress, collapseProgress);

  if (Buffer.byteLength(input, 'utf8') >= config.min_input_bytes) {
    apply('repeated_lines', config.filters.repeated_lines, collapseRepeatedLines);
    apply('package_manager', config.filters.package_manager, reducePackageManagerOutput);
    apply('test_output', config.filters.test_output, reduceTestOutput);
    apply('stack_trace', config.filters.stack_trace, reduceStackTrace);
    apply('diff_context', config.filters.diff_context, reduceDiffContext);

    const needsBudget = Buffer.byteLength(text, 'utf8') > config.max_output_bytes;
    if (context.isError && (appliedFilters.length > 0 || needsBudget)) {
      text = `${diagnosticHeader(context)}${text}`;
    }
    if (Buffer.byteLength(text, 'utf8') > config.max_output_bytes) {
      text = fitToByteBudget(text, config.max_output_bytes);
      appliedFilters.push('size_budget');
    }
  }

  return result(input, text, appliedFilters);
}

function result(input: string, output: string, appliedFilters: string[]): SignalFilterResult {
  return {
    text: output,
    stats: {
      inputBytes: Buffer.byteLength(input, 'utf8'),
      outputBytes: Buffer.byteLength(output, 'utf8'),
      inputLines: lineCount(input),
      outputLines: lineCount(output),
    },
    appliedFilters,
  };
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

function cleanAnsiAndControls(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function collapseProgress(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const redraws = line.split('\r').filter((part) => part.trim().length > 0);
      return redraws.at(-1) ?? '';
    })
    .join('\n');
}

function normalizeRepeatedLine(line: string): string {
  return line
    .trim()
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds?)\b/gi, '<time>')
    .replace(/\s+/g, ' ');
}

function collapseRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const normalized = normalizeRepeatedLine(lines[index]);
    let end = index + 1;
    while (end < lines.length && normalizeRepeatedLine(lines[end]) === normalized) end += 1;
    const count = end - index;
    output.push(lines[index]);
    if (count >= 3) output.push(`[... previous line repeated ${count} times ...]`);
    else for (let current = index + 1; current < end; current += 1) output.push(lines[current]);
    index = end;
  }
  return output.join('\n');
}

function reducePackageManagerOutput(text: string, context: SignalFilterContext): string {
  const recognized = /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|i|ci|add|update|build|run\s+build)(?:\s|$)/i.test(context.command ?? '')
    || /^(?:npm (?:warn|error|http)|Packages:|Progress:)/m.test(text);
  if (!recognized) return text;
  return reduceRegions(text, (line) =>
    ERROR_PATTERN.test(line)
    || SUMMARY_PATTERN.test(line)
    || /\b(?:deprecated|warning|warn|audit|funding|lockfile)\b/i.test(line), 'package-manager lines');
}

function reduceTestOutput(text: string, context: SignalFilterContext): string {
  const recognized = /(?:^|\s)(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|vitest|jest|pytest|node\s+--test)(?:\s|$)/i.test(context.command ?? '')
    || /^(?:PASS|FAIL|Tests?:|Test Files|Suites:)/m.test(text);
  if (!recognized) return text;
  return reduceRegions(text, (line) =>
    ERROR_PATTERN.test(line)
    || EXIT_PATTERN.test(line)
    || FILE_REFERENCE_PATTERN.test(line)
    || SUMMARY_PATTERN.test(line)
    || /^(?:FAIL|×|✗|not ok|Caused by:)/i.test(line.trim()), 'passing test lines');
}

function reduceStackTrace(text: string): string {
  if (!/(?:^|\n)(?:\w*(?:Error|Exception):|\s+at\s+|Caused by:)/m.test(text)) return text;
  const lines = text.split('\n');
  let genericFrames = 0;
  const keep = lines.map((line) => {
    const isFrame = /^\s*at\s+/.test(line);
    if (!isFrame) return true;
    if (!/node_modules|node:internal|internal\//.test(line)) return true;
    genericFrames += 1;
    return genericFrames <= 4;
  });
  return renderSelected(lines, keep, 'stack frames');
}

function reduceDiffContext(text: string): string {
  if (!/^(?:diff --git |--- |\+\+\+ |@@ )/m.test(text)) return text;
  const lines = text.split('\n');
  const keep = lines.map((line, index) => {
    if (/^(?:diff --git |index |--- |\+\+\+ |@@ |[+-])/.test(line)) return true;
    return lines.slice(Math.max(0, index - 2), index + 3).some((nearby) => /^[+-](?![+-])/.test(nearby));
  });
  return renderSelected(lines, keep, 'unchanged lines');
}

function reduceRegions(text: string, keepLine: (line: string) => boolean, label: string): string {
  const lines = text.split('\n');
  const keep = lines.map((line, index) => {
    if (keepLine(line)) return true;
    return lines.slice(Math.max(0, index - 1), index + 2).some(keepLine);
  });
  return renderSelected(lines, keep, label);
}

function renderSelected(lines: string[], keep: boolean[], label: string): string {
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (keep[index]) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !keep[end]) end += 1;
    output.push(`[... ${end - index} ${label} omitted ...]`);
    index = end;
  }
  return output.join('\n');
}

function diagnosticHeader(context: SignalFilterContext): string {
  return [
    '[Nexus signal filter]',
    `Tool: ${context.toolName}`,
    ...(context.command ? [`Command: ${context.command}`] : []),
    'Status: failed',
    '',
  ].join('\n');
}

function mandatorySignal(line: string): boolean {
  return ERROR_PATTERN.test(line)
    || EXIT_PATTERN.test(line)
    || FILE_REFERENCE_PATTERN.test(line)
    || SUMMARY_PATTERN.test(line)
    || /^(?:\[Nexus signal filter\]|Tool:|Command:|Status:|Caused by:|FAIL\b|diff --git |--- |\+\+\+ |@@ |[+-](?![+-]))/i.test(line);
}

function fitToByteBudget(text: string, maxBytes: number): string {
  const lines = text.split('\n');
  const keep = lines.map((line, index) => index < 10 || index >= lines.length - 10 || mandatorySignal(line));
  for (let index = 0; index < lines.length; index += 1) {
    if (!mandatorySignal(lines[index])) continue;
    for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 2); nearby += 1) {
      keep[nearby] = true;
    }
  }

  let output = renderSelected(lines, keep, 'lines');
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;

  const essential = lines.filter((line, index) => mandatorySignal(line) || index < 3 || index >= lines.length - 3);
  output = renderSelected(lines, lines.map((line, index) => essential.includes(line) && (mandatorySignal(line) || index < 3 || index >= lines.length - 3)), 'lines');
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;

  const marker = '\n[... output truncated to signal budget ...]\n';
  const allowance = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const head = utf8Prefix(output, Math.floor(allowance / 2));
  const tail = utf8Suffix(output, allowance - Buffer.byteLength(head, 'utf8'));
  return `${head}${marker}${tail}`;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let output = '';
  for (const character of text) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) break;
    output += character;
  }
  return output;
}

function utf8Suffix(text: string, maxBytes: number): string {
  let output = '';
  for (const character of Array.from(text).reverse()) {
    if (Buffer.byteLength(character + output, 'utf8') > maxBytes) break;
    output = character + output;
  }
  return output;
}
