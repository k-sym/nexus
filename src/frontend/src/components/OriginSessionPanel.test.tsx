import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BoardInboxItem, OriginDraft, Project } from '@nexus/shared';
import { api } from '../api';
import OriginSessionPanel, { withBranchType } from './OriginSessionPanel';

vi.mock('../api', () => ({
  api: {
    projects: {
      boardDraft: vi.fn(),
    },
  },
}));

vi.mock('../hooks/useModels', () => ({
  modelKey: (provider: string, id: string) => `${provider}/${id}`,
  useModels: () => ({
    models: [
      { provider: 'claude-code', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { provider: 'claude-code', id: 'claude-opus-5', name: 'Claude Opus 5' },
    ],
    activeModelId: 'claude-code/claude-sonnet-5',
  }),
}));

const project = (id: string, name: string): Project => ({
  id, slug: id, name, badge: name.slice(0, 3).toUpperCase(), description: '', repo_path: `/repo/${id}`,
  config_json: '{}', git_remote: '', created_at: 'now', updated_at: 'now',
});
const projects = [project('nexus', 'Nexus'), project('mywise', 'MyWise')];

const issue: BoardInboxItem = {
  kind: 'github', id: '439', title: 'Session-first Kanban',
  url: 'https://github.com/k-sym/nexus/issues/439', labels: ['enhancement'], status_label: null, updated: null,
};

const draft: OriginDraft = {
  origin: { kind: 'github', id: '439' },
  problem: 'The board shows tasks nobody maintains; make cards sessions.',
  projectId: 'mywise',
  branchType: 'fix',
  branchName: 'fix/session-first-kanban',
  model: 'claude-code/claude-sonnet-5',
};

describe('OriginSessionPanel', () => {
  beforeEach(() => {
    vi.mocked(api.projects.boardDraft).mockReset();
  });

  it('shows the item title, a link to it, and defaults the project to the board project', () => {
    render(<OriginSessionPanel projectId="nexus" item={issue} projects={projects} onGo={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Session-first Kanban' })).toBeInTheDocument();
    expect(screen.getByText('GitHub issue #439')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open on github/i })).toHaveAttribute('href', issue.url);
    expect(screen.getByText('enhancement')).toBeInTheDocument();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('nexus');
    expect((screen.getByLabelText('Branch type') as HTMLSelectElement).value).toBe('feat');
    // Nothing to go with yet.
    expect(screen.getByRole('button', { name: /^go$/i })).toBeDisabled();
  });

  it('drafts with Sonnet, lets every field be edited, and Go hands the edited values to the parent', async () => {
    vi.mocked(api.projects.boardDraft).mockResolvedValue(draft);
    const onGo = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<OriginSessionPanel projectId="nexus" item={issue} projects={projects} onGo={onGo} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /draft with sonnet/i }));
    await waitFor(() => expect(api.projects.boardDraft).toHaveBeenCalledWith('nexus', { kind: 'github', id: '439' }));

    // The draft fills the form: prompt, type, branch, and the project it picked.
    const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toBe(draft.problem));
    expect((screen.getByLabelText('Branch type') as HTMLSelectElement).value).toBe('fix');
    expect((screen.getByLabelText('Branch name') as HTMLInputElement).value).toBe('fix/session-first-kanban');
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('mywise');
    expect(screen.getByRole('button', { name: /draft again/i })).toBeInTheDocument();

    // Edit everything.
    await user.selectOptions(screen.getByLabelText('Project'), 'nexus');
    await user.selectOptions(screen.getByLabelText('Model'), 'claude-code/claude-opus-5');
    await user.clear(screen.getByLabelText('Branch name'));
    await user.type(screen.getByLabelText('Branch name'), 'fix/board-cards');
    await user.clear(prompt);
    await user.type(prompt, 'Edited problem statement');

    await user.click(screen.getByRole('button', { name: /^go$/i }));

    expect(onGo).toHaveBeenCalledWith(issue, {
      projectId: 'nexus',
      problem: 'Edited problem statement',
      branchName: 'fix/board-cards',
      modelKey: 'claude-code/claude-opus-5',
    });
  });

  it('changing the type rewrites the branch prefix and keeps the slug', async () => {
    vi.mocked(api.projects.boardDraft).mockResolvedValue(draft);
    const user = userEvent.setup();
    render(<OriginSessionPanel projectId="nexus" item={issue} projects={projects} onGo={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /draft with sonnet/i }));
    const branch = screen.getByLabelText('Branch name') as HTMLInputElement;
    await waitFor(() => expect(branch.value).toBe('fix/session-first-kanban'));

    await user.selectOptions(screen.getByLabelText('Branch type'), 'hotfix');
    expect(branch.value).toBe('hotfix/session-first-kanban');

    await user.selectOptions(screen.getByLabelText('Branch type'), 'feat');
    expect(branch.value).toBe('feat/session-first-kanban');

    // The three board types, and only those (D10).
    const options = Array.from((screen.getByLabelText('Branch type') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['feat', 'fix', 'hotfix']);
  });

  it('surfaces a draft failure and a Go failure without losing the form', async () => {
    vi.mocked(api.projects.boardDraft).mockRejectedValue(new Error('Draft model unavailable'));
    const onGo = vi.fn().mockRejectedValue(new Error('Branch already exists'));
    const user = userEvent.setup();
    render(<OriginSessionPanel projectId="nexus" item={issue} projects={projects} onGo={onGo} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /draft with sonnet/i }));
    expect(await screen.findByText('Draft model unavailable')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Prompt'), 'Hand-written problem');
    await user.type(screen.getByLabelText('Branch name'), 'feat/by-hand');
    await user.click(screen.getByRole('button', { name: /^go$/i }));

    expect(await screen.findByText('Branch already exists')).toBeInTheDocument();
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Hand-written problem');
    expect(screen.getByRole('button', { name: /^go$/i })).toBeEnabled();
  });

  it('resets the form when the selected item changes, keeping the model preference', async () => {
    vi.mocked(api.projects.boardDraft).mockResolvedValue(draft);
    const user = userEvent.setup();
    const { rerender } = render(<OriginSessionPanel projectId="nexus" item={issue} projects={projects} onGo={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /draft with sonnet/i }));
    await waitFor(() => expect((screen.getByLabelText('Branch name') as HTMLInputElement).value).toBe('fix/session-first-kanban'));
    await user.selectOptions(screen.getByLabelText('Model'), 'claude-code/claude-opus-5');

    const mondayItem: BoardInboxItem = { kind: 'monday', id: 'm-2', title: 'Quarterly roadmap', url: null, labels: [], status_label: 'Working on it', updated: null };
    rerender(<OriginSessionPanel projectId="nexus" item={mondayItem} projects={projects} onGo={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('Monday item')).toBeInTheDocument();
    expect(screen.getByText('Working on it')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect((screen.getByLabelText('Branch name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('claude-code/claude-opus-5');
  });

  it('calls onClose from the header control', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<OriginSessionPanel projectId="nexus" item={issue} projects={projects} onGo={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('withBranchType', () => {
  it('swaps a known prefix and prepends when there is none', () => {
    expect(withBranchType('fix/thing', 'feat')).toBe('feat/thing');
    expect(withBranchType('HOTFIX/thing', 'fix')).toBe('fix/thing');
    expect(withBranchType('thing', 'hotfix')).toBe('hotfix/thing');
    // Unknown prefixes (the Jira form) are kept as part of the slug.
    expect(withBranchType('feature/thing', 'fix')).toBe('fix/feature/thing');
  });
});
