import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ActivityConsole from './ActivityConsole';
import type { ActivityResponse, Operation } from '../api';
import type { Project, Task } from '@nexus/shared';

const projects: Project[] = [{ id: 'p1', slug: 'demo', name: 'Demo', description: '', repo_path: '/tmp/demo', config_json: '{}', git_remote: '', created_at: '', updated_at: '' }];
const tasks: Task[] = [];
const threads = [];

function makeOp(overrides: Partial<Operation>): Operation {
  return {
    id: 'op-1',
    kind: 'chat_turn',
    status: 'running',
    title: 'Demo / Test',
    project_id: 'p1',
    task_id: null,
    thread_id: 't1',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: 1200,
    last_event: 'context_usage',
    error: null,
    ...overrides,
  };
}

const operations: ActivityResponse = {
  running: [makeOp({ id: 'op-run' })],
  recent: [makeOp({ id: 'op-done', status: 'succeeded', title: 'Demo / Done', duration_ms: 5000 })],
  counts: { running: 1, succeeded: 1, failed: 0, cancelled: 0 },
};

describe('ActivityConsole', () => {
  it('renders running and recent rows', () => {
    render(
      <ActivityConsole
        operations={operations}
        loading={false}
        projects={projects}
        tasks={tasks}
        threads={threads}
        onRefresh={() => {}}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onAbort={() => {}}
        onRetry={() => {}}
        onCopyDiagnostics={() => {}}
      />,
    );
    expect(screen.getByText('Demo / Test')).toBeInTheDocument();
    expect(screen.getByText('Demo / Done')).toBeInTheDocument();
    expect(screen.getAllByText('running').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('succeeded').length).toBeGreaterThanOrEqual(1);
  });

  it('opens detail panel when a row is clicked', () => {
    render(
      <ActivityConsole
        operations={operations}
        loading={false}
        projects={projects}
        tasks={tasks}
        threads={threads}
        onRefresh={() => {}}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onAbort={() => {}}
        onRetry={() => {}}
        onCopyDiagnostics={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Demo / Test'));
    expect(screen.getByText('Last event')).toBeInTheDocument();
    expect(screen.getByText('context_usage')).toBeInTheDocument();
  });

  it('calls abort when stop button is clicked', () => {
    const onAbort = vi.fn();
    render(
      <ActivityConsole
        operations={operations}
        loading={false}
        projects={projects}
        tasks={tasks}
        threads={threads}
        onRefresh={() => {}}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onAbort={onAbort}
        onRetry={() => {}}
        onCopyDiagnostics={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByTitle('Stop')[0]);
    expect(onAbort).toHaveBeenCalledWith('op-run');
  });

  it('filters by status', () => {
    render(
      <ActivityConsole
        operations={operations}
        loading={false}
        projects={projects}
        tasks={tasks}
        threads={threads}
        onRefresh={() => {}}
        onSelectProject={() => {}}
        onSelectThread={() => {}}
        onAbort={() => {}}
        onRetry={() => {}}
        onCopyDiagnostics={() => {}}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('All statuses'), { target: { value: 'failed' } });
    expect(screen.queryByText('Demo / Test')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo / Done')).not.toBeInTheDocument();
    expect(screen.getByText('No operations match the current filters.')).toBeInTheDocument();
  });
});
