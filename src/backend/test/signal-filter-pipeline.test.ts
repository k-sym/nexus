import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG, type ResolvedSignalFilterConfig } from '../signal-filters/config';
import { filterSignal, type SignalFilterContext } from '../signal-filters/pipeline';

function config(overrides: Partial<ResolvedSignalFilterConfig> = {}): ResolvedSignalFilterConfig {
  return {
    ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
    ...overrides,
    filters: { ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG.filters, ...(overrides.filters ?? {}) },
  };
}

function bash(command: string, isError = false): SignalFilterContext {
  return { toolName: 'bash', command, isError };
}

test('strips ANSI and keeps the final carriage-return progress state', () => {
  const input = '\u001b[32mInstalling\u001b[0m 10%\rInstalling 80%\rInstalling 100%\nadded 42 packages';
  const result = filterSignal(input, bash('npm install'), config({ min_input_bytes: 1 }));
  assert.doesNotMatch(result.text, /\u001b|10%|80%/);
  assert.match(result.text, /Installing 100%/);
  assert.equal(result.stats.inputBytes, Buffer.byteLength(input));
  assert.equal(result.stats.outputBytes, Buffer.byteLength(result.text));
  assert.deepEqual(result.appliedFilters.slice(0, 2), ['ansi', 'progress']);
});

test('reports UTF-8 bytes and bypasses disabled filters', () => {
  const result = filterSignal('✓✓✓', bash('echo ok'), config({ enabled: false }));
  assert.equal(result.text, '✓✓✓');
  assert.equal(result.stats.inputBytes, 9);
  assert.equal(result.stats.outputBytes, 9);
  assert.deepEqual(result.appliedFilters, []);
});

test('small input skips structural filters', () => {
  const input = 'warning repeated\nwarning repeated\nwarning repeated';
  const result = filterSignal(input, bash('npm install'), config({ min_input_bytes: 4096 }));
  assert.equal(result.text, input);
  assert.deepEqual(result.appliedFilters, []);
});

test('groups repeated warnings with volatile timings normalized', () => {
  const input = Array.from({ length: 40 }, (_, i) => `warning package deprecated (${i + 1}ms)`).join('\n');
  const result = filterSignal(input, bash('npm install'), config({ min_input_bytes: 1 }));
  assert.match(result.text, /warning package deprecated/);
  assert.match(result.text, /repeated 40 times/);
});

test('reduces successful npm output while retaining totals and warnings', () => {
  const input = [
    ...Array.from({ length: 80 }, (_, i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} 20ms`),
    'npm warn deprecated old-package@1.0.0: no longer supported',
    'added 421 packages, and audited 422 packages in 8s',
    '0 vulnerabilities',
  ].join('\n');
  const result = filterSignal(input, bash('npm install'), config({ min_input_bytes: 1 }));
  assert.doesNotMatch(result.text, /pkg-73/);
  assert.match(result.text, /deprecated old-package/);
  assert.match(result.text, /added 421 packages/);
  assert.match(result.text, /0 vulnerabilities/);
  assert.ok(result.appliedFilters.includes('package_manager'));
});

test('reduces passing tests but retains totals', () => {
  const input = [
    ...Array.from({ length: 120 }, (_, i) => `✓ passes case ${i + 1}`),
    'Test Files  12 passed (12)',
    'Tests  120 passed (120)',
    'Duration  3.2s',
  ].join('\n');
  const result = filterSignal(input, bash('npm test'), config({ min_input_bytes: 1 }));
  assert.doesNotMatch(result.text, /passes case 73/);
  assert.match(result.text, /Test Files  12 passed/);
  assert.match(result.text, /Tests  120 passed/);
  assert.ok(result.appliedFilters.includes('test_output'));
});

test('failed tests preserve command, assertion, file reference, cause, and exit code', () => {
  const input = [
    'FAIL src/parser.test.ts',
    'AssertionError: expected 1 to equal 2',
    '  at parseValue (src/parser.ts:42:9)',
    ...Array.from({ length: 80 }, (_, i) => `  at framework${i} (node_modules/test/index.js:${i + 1}:1)`),
    'Caused by: Error: invalid token',
    '  at tokenize (src/token.ts:9:3)',
    'Tests: 1 failed, 20 passed, 21 total',
    'Command exited with code 1',
  ].join('\n');
  const result = filterSignal(input, bash('npm test', true), config({ min_input_bytes: 1 }));
  assert.match(result.text, /Tool: bash/);
  assert.match(result.text, /Command: npm test/);
  assert.match(result.text, /Status: failed/);
  assert.match(result.text, /AssertionError/);
  assert.match(result.text, /src\/parser\.ts:42:9/);
  assert.match(result.text, /Caused by/);
  assert.match(result.text, /Command exited with code 1/);
  assert.doesNotMatch(result.text, /framework73/);
});

test('reduces stack frame noise while retaining application frames', () => {
  const input = [
    'TypeError: broken',
    '  at run (src/run.ts:10:2)',
    ...Array.from({ length: 40 }, (_, i) => `  at internal${i} (node_modules/lib/index.js:${i + 1}:1)`),
    '  at main (src/main.ts:3:1)',
  ].join('\n');
  const result = filterSignal(input, bash('node app.js', true), config({ min_input_bytes: 1 }));
  assert.match(result.text, /src\/run\.ts:10:2/);
  assert.match(result.text, /src\/main\.ts:3:1/);
  assert.match(result.text, /stack frames omitted/);
});

test('reduces unchanged diff context while preserving headers and changes', () => {
  const input = [
    'diff --git a/src/file.ts b/src/file.ts',
    '--- a/src/file.ts',
    '+++ b/src/file.ts',
    '@@ -1,80 +1,80 @@',
    ...Array.from({ length: 40 }, (_, i) => ` context before ${i}`),
    '-const fixed = false;',
    '+const fixed = true;',
    ...Array.from({ length: 40 }, (_, i) => ` context after ${i}`),
  ].join('\n');
  const result = filterSignal(input, { toolName: 'edit', isError: false }, config({ min_input_bytes: 1 }));
  assert.match(result.text, /^--- a\/src\/file.ts/m);
  assert.match(result.text, /^\+const fixed = true;/m);
  assert.match(result.text, /unchanged lines omitted/);
});

test('final budget keeps head, error neighborhood, and tail', () => {
  const input = [
    'HEAD',
    ...Array.from({ length: 500 }, (_, i) => `ordinary log ${i} ${'x'.repeat(60)}`),
    'near-before',
    'ERROR src/worker.ts:88:4 exploded',
    'near-after',
    ...Array.from({ length: 500 }, (_, i) => `later log ${i} ${'y'.repeat(60)}`),
    'TAIL',
  ].join('\n');
  const result = filterSignal(input, bash('custom-command', true), config({ min_input_bytes: 1, max_output_bytes: 4000 }));
  assert.ok(result.stats.outputBytes <= 4000);
  assert.match(result.text, /HEAD/);
  assert.match(result.text, /near-before/);
  assert.match(result.text, /src\/worker\.ts:88:4/);
  assert.match(result.text, /near-after/);
  assert.match(result.text, /TAIL/);
  assert.match(result.text, /lines omitted/);
});

test('filtering is deterministic', () => {
  const input = `${'PASS noisy\n'.repeat(100)}Tests: 100 passed`;
  const first = filterSignal(input, bash('npm test'), config({ min_input_bytes: 1 }));
  const second = filterSignal(input, bash('npm test'), config({ min_input_bytes: 1 }));
  assert.deepEqual(first, second);
});
