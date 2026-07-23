import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TaskModal from './TaskModal';
import * as api from '../api';
import type { Task } from '@nexus/shared';

const TASK: Task = {
  id: 'task-1',
  project_id: 'project-1',
  title: 'Design ambient board',
  description: 'Let the background show through the lane.',
  status: 'triage',
  priority: 'medium',
  assigned_agent: null,
  due_date: null,
  created_at: '2026-06-11T07:00:00.000Z',
  updated_at: '2026-06-11T07:00:00.000Z',
  model_key: null,
  thread_id: null,
  external_source: null,
  external_id: null,
};

const ITEM = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
  name: 'Ship the thing', state: 'active' as const, status_label: null, status_color: null,
  owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  rollup: { total: 1, open: 1, inProgress: 0, inReview: 0, done: 0 },
  rollup_text: '0/1 done',
  task_ids: ['task-1'],
};

beforeEach(() => vi.restoreAllMocks());

describe('TaskModal — Monday initiative section', () => {
  it('does not render a Monday section in create mode (no task id to link yet)', () => {
    render(
      <TaskModal columnLabel="Triage" projectId="project-1" onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByPlaceholderText(/search monday/i)).toBeNull();
    expect(screen.queryByText(/monday initiative/i)).toBeNull();
  });

  it('links the task to a Monday item chosen in the picker, then reflects the link and notifies the parent', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([] as never);
    const search = vi.spyOn(api, 'searchMondayItems').mockResolvedValue([ITEM] as never);
    const link = vi.spyOn(api, 'linkTaskToMondayItem').mockResolvedValue(undefined as never);
    const onMondayLinkChanged = vi.fn();

    render(
      <TaskModal
        task={TASK}
        projectId="project-1"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onMondayLinkChanged={onMondayLinkChanged}
      />,
    );

    // No prior link — confirmed by the fetch above resolving empty.
    await waitFor(() => expect(api.fetchMondayItems).toHaveBeenCalledWith('project-1'));
    expect(screen.queryByText('Ship the thing')).toBeNull();

    // Now the link exists — the next fetchMondayItems call (triggered by
    // onLinked) reflects it.
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);

    await userEvent.type(screen.getByPlaceholderText(/search monday/i), 'ship');
    await waitFor(() => expect(search).toHaveBeenCalledWith('project-1', 'ship'));
    await userEvent.click(await screen.findByText('Ship the thing'));

    await waitFor(() => expect(link).toHaveBeenCalledWith('project-1', 'task-1', '1'));
    // The modal's own current-link display updates to show the newly linked item.
    await waitFor(() => expect(screen.getAllByText('Ship the thing').length).toBeGreaterThan(0));
    expect(onMondayLinkChanged).toHaveBeenCalled();
  });

  it('unlinks the current Monday item from the task and clears the displayed link', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValueOnce([ITEM] as never).mockResolvedValue([] as never);
    vi.spyOn(api, 'searchMondayItems').mockResolvedValue([] as never);
    const unlink = vi.spyOn(api, 'unlinkTaskFromMondayItem').mockResolvedValue(undefined as never);
    const onMondayLinkChanged = vi.fn();

    render(
      <TaskModal
        task={TASK}
        projectId="project-1"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onMondayLinkChanged={onMondayLinkChanged}
      />,
    );

    // The current link shows up first, proving the section reads real state
    // rather than always rendering empty.
    expect(await screen.findByText('Ship the thing')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /unlink/i }));

    await waitFor(() => expect(unlink).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(screen.queryByText('Ship the thing')).toBeNull());
    expect(onMondayLinkChanged).toHaveBeenCalled();
  });
});
