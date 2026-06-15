import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TriageToProject from './TriageToProject';
import type { Project } from '@nexus/shared';

const projects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta' },
] as Project[];

describe('TriageToProject', () => {
  it('prompts to create a project when none exist', () => {
    render(<TriageToProject projects={[]} onCreate={vi.fn()} />);
    expect(screen.getByText(/create a project first/i)).toBeInTheDocument();
  });

  it('calls onCreate with the selected project and shows success', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<TriageToProject projects={projects} onCreate={onCreate} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('p2'));
    expect(await screen.findByText(/created in beta/i)).toBeInTheDocument();
  });

  it('shows an error message when onCreate rejects', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('boom'));
    render(<TriageToProject projects={projects} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));
    expect(await screen.findByText(/failed to create task/i)).toBeInTheDocument();
  });
});
