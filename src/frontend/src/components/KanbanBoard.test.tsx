import { render, screen, fireEvent } from '@testing-library/react';
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
  thread_id: null,
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

  it('opens the card (edit when unlinked, reopen-chat when linked) via onOpenTask, and shows a chat glyph only when linked', () => {
    const onOpenTask = vi.fn();
    const linked: Task = { ...task, id: 'task-2', title: 'Linked task', thread_id: 'thread-9' };
    const { rerender } = render(
      <KanbanBoard
        tasks={[task]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={onOpenTask}
        onDeleteTask={vi.fn()}
      />,
    );

    // Unlinked card: clicking calls onOpenTask with the task; no chat glyph.
    let card = screen.getByText('Design ambient board').closest('[data-kanban-card]')!;
    expect(card.querySelector('[aria-label="Has a linked chat"]')).toBeNull();
    fireEvent.click(card);
    expect(onOpenTask).toHaveBeenCalledWith(task);

    // Linked card: chat glyph present, click still routes through onOpenTask.
    rerender(
      <KanbanBoard
        tasks={[linked]}
        columns={['triage']}
        columnLabels={{ triage: 'Triage' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onOpenTask={onOpenTask}
        onDeleteTask={vi.fn()}
      />,
    );
    card = screen.getByText('Linked task').closest('[data-kanban-card]')!;
    expect(card.querySelector('[aria-label="Has a linked chat"]')).not.toBeNull();
    fireEvent.click(card);
    expect(onOpenTask).toHaveBeenCalledWith(linked);
  });
});
