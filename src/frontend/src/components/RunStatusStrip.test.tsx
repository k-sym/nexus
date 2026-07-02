import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStatusStrip } from './RunStatusStrip';
import type { AgentRunView } from '../chat/agent-run-state';

function run(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'r1', threadId: 't1', status: 'running', phase: 'model_responding',
    startedAt: Date.now() - 5_000, lastEventAt: Date.now() - 2_000,
    provider: 'openrouter', model: 'glm-5.2', tools: [], ...overrides,
  };
}

describe('RunStatusStrip', () => {
  it('shows phase, elapsed, last-activity, and model from the run view', () => {
    render(<RunStatusStrip run={run()} fallbackLabel="Working…" />);
    const strip = screen.getByTestId('run-status');
    expect(strip).toHaveTextContent('Model responding');
    expect(strip).toHaveTextContent(/last activity/i);
    expect(strip).toHaveTextContent('openrouter/glm-5.2');
  });

  it('falls back to the coarse label when no run view is available', () => {
    render(<RunStatusStrip run={null} fallbackLabel="Thinking" />);
    const strip = screen.getByTestId('run-status');
    expect(strip).toHaveTextContent('Thinking');
    expect(strip).not.toHaveTextContent(/last activity/i);
  });
});
