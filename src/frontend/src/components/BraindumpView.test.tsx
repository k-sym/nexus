import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BraindumpView from './BraindumpView';
import type { Project } from '@nexus/shared';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    braindump: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const projects = [{ id: 'p1', name: 'Alpha' }] as Project[];

beforeEach(() => {
  vi.clearAllMocks();
  (api.braindump.list as any).mockResolvedValue([]);
});

describe('BraindumpView', () => {
  it('renders the quick-add input', async () => {
    render(<BraindumpView projects={projects} onTriage={vi.fn()} />);
    expect(await screen.findByPlaceholderText(/capture an idea/i)).toBeInTheDocument();
  });

  it('creates an idea from the quick-add input', async () => {
    (api.braindump.create as any).mockResolvedValue({ id: 'i1', title: 'New idea', body: '', status: 'active', project_id: null, task_id: null, created_at: '', updated_at: '' });
    render(<BraindumpView projects={projects} onTriage={vi.fn()} />);
    const input = await screen.findByPlaceholderText(/capture an idea/i);
    fireEvent.change(input, { target: { value: 'New idea' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.braindump.create).toHaveBeenCalledWith({ title: 'New idea' }));
  });

  it('uses current accent styling for focused and selected idea states', async () => {
    (api.braindump.list as any).mockResolvedValue([
      { id: 'i1', title: 'Test', body: '', status: 'active', project_id: null, task_id: null, created_at: '', updated_at: '' },
    ]);

    render(<BraindumpView projects={projects} onTriage={vi.fn()} />);

    const input = await screen.findByPlaceholderText(/capture an idea/i);
    expect(input).toHaveClass('focus:border-strong');
    expect(input).not.toHaveClass('focus:border-indigo-500/60');

    const idea = await screen.findByRole('button', { name: /Test/ });
    fireEvent.click(idea);

    expect(idea).toHaveClass('border-strong');
    expect(idea).not.toHaveClass('border-indigo-500/60');
    expect(screen.getByPlaceholderText(/flesh out the idea/i)).toHaveClass('focus:border-strong');
  });
});
