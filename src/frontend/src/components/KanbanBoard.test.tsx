import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import KanbanBoard from './KanbanBoard';
import { Task } from '@nexus/shared';

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
};

describe('KanbanBoard', () => {
  it('renders tasks in open ambient lanes instead of hard glass columns', () => {
    render(
      <KanbanBoard
        tasks={[task]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onEditTask={vi.fn()}
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
        onEditTask={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );

    const card = screen.getByText('Design ambient board').closest('[data-kanban-card]');

    expect(card).toHaveClass('kanban-priority-medium');
    expect(card).toHaveAttribute('data-priority', 'medium');
    expect(card?.querySelector('[data-priority-dot]')).toBeNull();
  });
});
