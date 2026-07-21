import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectModal from './ProjectModal';
import type { Project } from '@nexus/shared';

const existing: Project = {
  id: 'p1',
  slug: 'brooklyn-roasters',
  name: 'Brooklyn Roasters',
  badge: 'BRK',
  description: '',
  repo_path: '/repo/br',
  config_json: '{}',
  git_remote: '',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

describe('ProjectModal', () => {
  it('derives the badge from the name as you type', async () => {
    const user = userEvent.setup();
    render(<ProjectModal onClose={vi.fn()} onSubmit={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('My Awesome Project'), 'United States of America');

    expect(screen.getByLabelText('Rail Badge')).toHaveValue('USA');
  });

  it('stops tracking the name once the badge is edited by hand', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ProjectModal onClose={vi.fn()} onSubmit={onSubmit} />);

    const nameInput = screen.getByPlaceholderText('My Awesome Project');
    await user.type(nameInput, 'Brooklyn Roasters');
    expect(screen.getByLabelText('Rail Badge')).toHaveValue('BR');

    const badgeInput = screen.getByLabelText('Rail Badge');
    await user.clear(badgeInput);
    await user.type(badgeInput, 'BRK');

    // Renaming must not clobber the deliberate choice.
    await user.type(nameInput, ' Coffee');
    expect(badgeInput).toHaveValue('BRK');

    await user.type(screen.getByPlaceholderText('~/Projects/my-app'), '/repo/br');
    await user.click(screen.getByRole('button', { name: 'Create Project' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Brooklyn Roasters Coffee',
      badge: 'BRK',
      repo_path: '/repo/br',
    });
  });

  it('caps the badge at three characters and uppercases input', async () => {
    const user = userEvent.setup();
    render(<ProjectModal onClose={vi.fn()} onSubmit={vi.fn()} />);

    const badgeInput = screen.getByLabelText('Rail Badge');
    await user.type(badgeInput, 'abcdef');

    expect(badgeInput).toHaveValue('ABC');
  });

  it('prefills an existing project badge when editing', () => {
    render(<ProjectModal onClose={vi.fn()} onSubmit={vi.fn()} project={existing} />);
    expect(screen.getByLabelText('Rail Badge')).toHaveValue('BRK');
  });

  it('no longer offers a description field', () => {
    render(<ProjectModal onClose={vi.fn()} onSubmit={vi.fn()} project={existing} />);
    expect(screen.queryByPlaceholderText('What is this project about?')).not.toBeInTheDocument();
  });
});
