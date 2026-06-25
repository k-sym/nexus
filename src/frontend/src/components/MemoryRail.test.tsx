import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import MemoryRail from './MemoryRail';

vi.mock('../api', () => ({
  api: {
    memory: {
      list: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const memoryApi = api.memory as unknown as {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const memory = {
  id: 'mem-rail-1',
  project_id: 'project-1',
  category: 'decision',
  title: 'Archive sessions',
  content: 'Full drawer memory body with decision, rationale, and next actions.',
  source: 'nexus:archive',
  created_at: '2026-06-25T09:00:00.000Z',
  updated_at: '2026-06-25T09:30:00.000Z',
};

describe('MemoryRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    memoryApi.list.mockResolvedValue([memory]);
    memoryApi.create.mockResolvedValue({ id: 'new-memory' });
  });

  it('reveals memory details inline when a drawer row is clicked', async () => {
    const user = userEvent.setup();
    render(<MemoryRail projectId="project-1" onOpenFull={vi.fn()} />);

    const row = await screen.findByRole('button', { name: /Archive sessions/ });
    expect(within(row).queryByText('Source: nexus:archive')).not.toBeInTheDocument();

    await user.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByText('Source: nexus:archive')).toBeInTheDocument();
    expect(within(row).getByText('Updated: 2026-06-25')).toBeInTheDocument();
    expect(within(row).getByText('Full drawer memory body with decision, rationale, and next actions.')).toBeInTheDocument();

    await user.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).queryByText('Source: nexus:archive')).not.toBeInTheDocument();
  });
});
