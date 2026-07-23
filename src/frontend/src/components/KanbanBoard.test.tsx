import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import KanbanBoard from './KanbanBoard';
import { Task } from '@nexus/shared';
import * as api from '../api';

const task: Task = {
  id: 'task-1',
  project_id: 'project-1',
  title: 'Design ambient board',
  description: 'Let the background show through the lane.',
  status: 'triage',
  priority: 'medium',
  assigned_agent: 'Codex',
  due_date: null,
  created_at: '2026-06-11T07:00:00.000Z',
  updated_at: '2026-06-11T07:00:00.000Z',
  model_key: null,
  thread_id: null,
  external_source: null,
  external_id: null,
};

describe('KanbanBoard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps the board usable — cards still render, drag/drop and add-task still work — when the Monday badge fetch rejects (e.g. an expired token)', async () => {
    const fetchMondayItems = vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(new Error('Monday token expired'));
    const onOpenTask = vi.fn();
    const onAddTask = vi.fn();

    render(
      <KanbanBoard
        tasks={[task]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        projectId="project-1"
        onMoveTask={vi.fn()}
        onAddTask={onAddTask}
        onOpenTask={onOpenTask}
        onDeleteTask={vi.fn()}
      />,
    );

    // The rejected fetch is real — confirm the board actually attempted it —
    // then confirm the board itself never surfaces the failure or blocks.
    await waitFor(() => expect(fetchMondayItems).toHaveBeenCalledWith('project-1'));

    const card = screen.getByText('Design ambient board').closest('[data-kanban-card]');
    expect(card).toBeInTheDocument();
    expect(screen.queryByText(/monday token expired/i)).toBeNull();

    // The board stays interactive: clicking a card and adding a task both
    // still fire their callbacks, and no badge is rendered for the task.
    fireEvent.click(screen.getByText('Design ambient board'));
    expect(onOpenTask).toHaveBeenCalledWith(task);
    fireEvent.click(screen.getByText('+'));
    expect(onAddTask).toHaveBeenCalledWith('triage');
    expect(card?.querySelector('[title*="no longer in Monday"]')).toBeNull();
  });

  it('renders tasks in open ambient lanes instead of hard glass columns', () => {
    render(
      <KanbanBoard
        tasks={[task]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );

    const title = screen.getByText('Design ambient board');
    const lane = title.closest('[data-kanban-lane]');
    const card = title.closest('[data-kanban-card]');

    expect(lane).toHaveClass('kanban-lane');
    expect(lane).not.toHaveClass('surface-glass');
    expect(card).toHaveClass('kanban-card');
  });

  it('renders priority as a left card band instead of a corner dot', () => {
    render(
      <KanbanBoard
        tasks={[task]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );

    const card = screen.getByText('Design ambient board').closest('[data-kanban-card]');

    expect(card).toHaveClass('kanban-priority-medium');
    expect(card).toHaveAttribute('data-priority', 'medium');
    expect(card?.querySelector('[data-priority-dot]')).toBeNull();
  });

  it('shows a Diff button for Review and Deploy tasks', () => {
    const review: Task = { ...task, id: 'review-task', status: 'review', title: 'Review me' };
    const deploy: Task = { ...task, id: 'deploy-task', status: 'deploy', title: 'Deploy me' };
    const onOpenDiffReview = vi.fn();
    const { rerender } = render(
      <KanbanBoard
        tasks={[review]}
        columns={['review']}
        columnLabels={{ review: 'Review' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onOpenDiffReview={onOpenDiffReview}
      />,
    );

    const diffButton = screen.getByRole('button', { name: 'Diff' });
    expect(diffButton).toBeInTheDocument();
    fireEvent.click(diffButton);
    expect(onOpenDiffReview).toHaveBeenCalledWith(review);

    rerender(
      <KanbanBoard
        tasks={[deploy]}
        columns={['deploy']}
        columnLabels={{ deploy: 'Deploy' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onOpenDiffReview={onOpenDiffReview}
      />,
    );

    expect(screen.getByRole('button', { name: 'Diff' })).toBeInTheDocument();
  });

  it('does not show a Diff button outside Review and Deploy', () => {
    render(
      <KanbanBoard
        tasks={[task]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onOpenDiffReview={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull();
  });
});
