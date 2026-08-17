import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import IdeasView from './IdeasView';
import type { Idea, Project } from '@nexus/shared';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    ideas: {
      list: vi.fn(),
      listByState: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      ensureSession: vi.fn(),
      graduateIssues: vi.fn(),
    },
  },
}));

// The idea thread + the research model picker speak apiFetch directly; give
// them a benign backend so selecting an idea can load its (empty) dialogue.
vi.mock('../api-base', () => ({
  apiFetch: vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      String(url).includes('/api/assistant/models')
        ? { models: [] }
        : { session: { id: 's1', title: 'Idea: x', status: 'idle' }, messages: [], latestRun: null },
  })),
}));

const projects = [{ id: 'p1', name: 'Alpha' }] as Project[];

function idea(overrides: Partial<Idea> & Pick<Idea, 'id' | 'title' | 'state'>): Idea {
  return {
    seed: '',
    tags: [],
    target_repo: null,
    session_id: null,
    graduated_to: null,
    source: 'idea_watcher',
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.ideas.list as any).mockResolvedValue([]);
  (api.ideas.ensureSession as any).mockResolvedValue({ sessionId: 's1' });
});

describe('IdeasView', () => {
  it('renders the quick-add capture input in the Parked section', async () => {
    render(<IdeasView projects={projects} />);
    const parkedSection = await screen.findByTestId('section-parked');
    expect(within(parkedSection).getByPlaceholderText(/park an idea/i)).toBeInTheDocument();
  });

  it('parks an idea from the quick-add input on Enter and shows it under Parked', async () => {
    (api.ideas.create as any).mockResolvedValue(idea({ id: 'i1', title: 'New idea', state: 'parked' }));
    render(<IdeasView projects={projects} />);

    const input = await screen.findByPlaceholderText(/park an idea/i);
    fireEvent.change(input, { target: { value: 'New idea' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.ideas.create).toHaveBeenCalledWith({ title: 'New idea' }));
    const parkedSection = screen.getByTestId('section-parked');
    expect(await within(parkedSection).findByText('New idea')).toBeInTheDocument();
    // Capture stays frictionless: the box is cleared for the next tangent.
    expect(input).toHaveValue('');
  });

  it('groups ideas by attention: reviewed → Waiting, discussing/researching → Ripening, parked → Parked', async () => {
    (api.ideas.list as any).mockResolvedValue([
      idea({ id: 'i1', title: 'Reviewed idea', state: 'reviewed' }),
      idea({ id: 'i2', title: 'Discussing idea', state: 'discussing' }),
      idea({ id: 'i3', title: 'Researching idea', state: 'researching' }),
      idea({ id: 'i4', title: 'Parked idea', state: 'parked' }),
    ]);
    render(<IdeasView projects={projects} />);

    const waiting = await screen.findByTestId('section-waiting');
    expect(within(waiting).getByText('Reviewed idea')).toBeInTheDocument();

    const ripening = screen.getByTestId('section-ripening');
    expect(within(ripening).getByText('Discussing idea')).toBeInTheDocument();
    expect(within(ripening).getByText('Researching idea')).toBeInTheDocument();

    const parked = screen.getByTestId('section-parked');
    expect(within(parked).getByText('Parked idea')).toBeInTheDocument();

    // No cross-contamination.
    expect(within(waiting).queryByText('Parked idea')).not.toBeInTheDocument();
    expect(within(ripening).queryByText('Reviewed idea')).not.toBeInTheDocument();
  });

  it('loads terminal ideas lazily when the Done section is expanded', async () => {
    (api.ideas.list as any).mockImplementation(async (all?: boolean) =>
      all
        ? [idea({ id: 'i9', title: 'Old graduated idea', state: 'graduated', graduated_to: { kind: 'issues', urls: ['https://github.com/o/r/issues/1'] } })]
        : [],
    );
    render(<IdeasView projects={projects} />);

    await screen.findByTestId('section-done');
    expect(api.ideas.list).toHaveBeenCalledWith();
    expect(api.ideas.list).not.toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(api.ideas.list).toHaveBeenCalledWith(true));
    expect(await screen.findByText('Old graduated idea')).toBeInTheDocument();
  });

  it('does not call graduateIssues until the Confirm button is pressed', async () => {
    const reviewed = idea({ id: 'i1', title: 'Ship the widget', state: 'reviewed', session_id: 's1', target_repo: 'k-sym/nexus' });
    (api.ideas.list as any).mockResolvedValue([reviewed]);
    (api.ideas.graduateIssues as any).mockResolvedValue({
      issues: [{ number: 7, html_url: 'https://github.com/k-sym/nexus/issues/7' }],
      idea: { ...reviewed, state: 'graduated', graduated_to: { kind: 'issues', urls: ['https://github.com/k-sym/nexus/issues/7'] } },
    });
    render(<IdeasView projects={projects} />);

    // Select the idea, open the Graduate dialog.
    fireEvent.click(await screen.findByRole('button', { name: 'Ship the widget' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Graduate' }));

    const dialog = await screen.findByRole('dialog', { name: 'Graduate idea' });
    expect(within(dialog).getByLabelText('Repository')).toHaveValue('k-sym/nexus');

    // Fill the draft (title is prefilled from the idea).
    fireEvent.change(within(dialog).getByLabelText('Issue 1 body'), {
      target: { value: 'Detailed body with context and acceptance criteria.' },
    });
    fireEvent.change(within(dialog).getByLabelText('Issue 1 labels'), { target: { value: 'enhancement, ux' } });

    // Editing and reviewing must not file anything — filing is confirm-gated.
    expect(api.ideas.graduateIssues).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('confirm-file-issues'));

    await waitFor(() => expect(api.ideas.graduateIssues).toHaveBeenCalledTimes(1));
    expect(api.ideas.graduateIssues).toHaveBeenCalledWith('i1', {
      repo: 'k-sym/nexus',
      issues: [{
        title: 'Ship the widget',
        body: 'Detailed body with context and acceptance criteria.',
        labels: ['enhancement', 'ux'],
      }],
    });

    // The created links render after filing.
    expect(await within(dialog).findByText(/#7 —/)).toBeInTheDocument();
  });

  it('closing the graduate dialog without confirming never files issues', async () => {
    const reviewed = idea({ id: 'i1', title: 'Ship the widget', state: 'reviewed', session_id: 's1', target_repo: 'k-sym/nexus' });
    (api.ideas.list as any).mockResolvedValue([reviewed]);
    render(<IdeasView projects={projects} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ship the widget' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Graduate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Graduate idea' });
    fireEvent.change(within(dialog).getByLabelText('Issue 1 body'), { target: { value: 'A body.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Graduate idea' })).not.toBeInTheDocument());
    expect(api.ideas.graduateIssues).not.toHaveBeenCalled();
  });
});
