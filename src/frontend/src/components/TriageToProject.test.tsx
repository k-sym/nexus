import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    const user = userEvent.setup();
    render(<TriageToProject projects={projects} onCreate={onCreate} />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /target project alpha/i }));
    await user.click(screen.getByRole('option', { name: 'Beta' }));
    expect(screen.getByRole('button', { name: /target project beta/i })).toHaveClass('triage-project-trigger');

    await user.click(screen.getByRole('button', { name: /create task/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('p2'));
    expect(await screen.findByText(/created in beta/i)).toBeInTheDocument();
  });

  it('uses the shell accent button styling for creating tasks', () => {
    render(<TriageToProject projects={projects} onCreate={vi.fn()} />);

    const createButton = screen.getByRole('button', { name: /create task/i });
    expect(createButton).toHaveClass('accent-button');
    expect(createButton).not.toHaveClass('bg-indigo-500');
  });

  it('shows an error message when onCreate rejects', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('boom'));
    render(<TriageToProject projects={projects} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));
    expect(await screen.findByText(/failed to create task/i)).toBeInTheDocument();
  });
});
