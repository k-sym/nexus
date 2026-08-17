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
      graduateProject: vi.fn(),
    },
  },
}));

// The idea thread + the research model picker speak apiFetch directly; give
// them a benign backend so selecting an idea can load its (empty) dialogue and
// message sends stream an immediately-closed body.
vi.mock('../api-base', () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (String(url).endsWith('/messages/stream')) {
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({ start(controller) { controller.close(); } }),
      };
    }
    return {
      ok: true,
      json: async () =>
        String(url).includes('/api/assistant/models')
          ? { models: [] }
          : { session: { id: 's1', title: 'Idea: x', status: 'idle' }, messages: [], latestRun: null },
    };
  }),
}));
import { apiFetch } from '../api-base';

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

  it('blocks attaching when the idea has no valid target repo: notice shown, no file dialog, nothing sent', async () => {
    (api.ideas.list as any).mockResolvedValue([
      idea({ id: 'i1', title: 'Repo-less idea', state: 'discussing', session_id: 's1', target_repo: null }),
    ]);
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    render(<IdeasView projects={projects} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Repo-less idea' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach files' }));

    expect(await screen.findByTestId('repo-gate-notice')).toHaveTextContent(
      'Set a valid target repo (owner/repo) on this idea before attaching files.',
    );
    // The hidden file input was never opened…
    expect(clickSpy).not.toHaveBeenCalled();
    // …and nothing went to the stream endpoint.
    expect(
      (apiFetch as any).mock.calls.filter(([url]: [string]) => String(url).endsWith('/messages/stream')),
    ).toHaveLength(0);
    // The target-repo input in the header takes focus for the fix.
    expect(screen.getByLabelText('Target repo')).toHaveFocus();
    clickSpy.mockRestore();
  });

  it('sends attachments in the stream body when the target repo is valid', async () => {
    (api.ideas.list as any).mockResolvedValue([
      idea({ id: 'i1', title: 'Repo-ful idea', state: 'discussing', session_id: 's1', target_repo: 'k-sym/nexus' }),
    ]);
    render(<IdeasView projects={projects} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Repo-ful idea' }));
    await screen.findByTestId('idea-chat-input');

    const file = new File(['file-bytes'], 'notes.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('idea-file-input'), { target: { files: [file] } });

    // The pending chip renders (no repo-gate notice).
    expect(await screen.findByTestId('pending-assistant-attachment')).toHaveTextContent('notes.pdf');
    expect(screen.queryByTestId('repo-gate-notice')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('idea-chat-input'), { target: { value: 'read this' } });
    fireEvent.click(screen.getByTestId('idea-send-button'));

    await waitFor(() => {
      const streamCalls = (apiFetch as any).mock.calls.filter(([url]: [string]) => String(url).endsWith('/messages/stream'));
      expect(streamCalls).toHaveLength(1);
      const body = JSON.parse(String(streamCalls[0][1].body));
      expect(body.content).toBe('read this');
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toMatchObject({ type: 'file', name: 'notes.pdf', mimeType: 'application/pdf' });
      expect(body.attachments[0].data).toBeTruthy();
    });
    // Pending chips clear once the turn is sent.
    await waitFor(() => expect(screen.queryByTestId('pending-assistant-attachment')).not.toBeInTheDocument());
  });

  it('graduates into a project via graduateProject and surfaces moved files', async () => {
    const reviewed = idea({ id: 'i1', title: 'Ship the widget', state: 'reviewed', session_id: 's1' });
    (api.ideas.list as any).mockResolvedValue([reviewed]);
    (api.ideas.graduateProject as any).mockResolvedValue({
      idea: { ...reviewed, state: 'graduated', graduated_to: { kind: 'project', projectId: 'p1' } },
      movedFiles: 3,
    });
    render(<IdeasView projects={projects} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ship the widget' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Graduate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Graduate idea' });

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Project' }));
    fireEvent.change(within(dialog).getByLabelText('Graduate into project'), { target: { value: 'p1' } });
    expect(api.ideas.graduateProject).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('confirm-graduate-project'));

    await waitFor(() => expect(api.ideas.graduateProject).toHaveBeenCalledWith('i1', 'p1'));
    expect(await within(dialog).findByTestId('graduate-project-result')).toHaveTextContent(
      '3 files moved into the project',
    );
  });

  it('surfaces the repo-path 400 verbatim and leaves the idea un-graduated', async () => {
    const reviewed = idea({ id: 'i1', title: 'Ship the widget', state: 'reviewed', session_id: 's1' });
    (api.ideas.list as any).mockResolvedValue([reviewed]);
    (api.ideas.graduateProject as any).mockRejectedValue(
      new Error('The project has no usable repo path to move this idea’s files into — fix the project first.'),
    );
    render(<IdeasView projects={projects} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ship the widget' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Graduate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Graduate idea' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Project' }));
    fireEvent.change(within(dialog).getByLabelText('Graduate into project'), { target: { value: 'p1' } });
    fireEvent.click(within(dialog).getByTestId('confirm-graduate-project'));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/no usable repo path/);
    // Not graduated: the idea stays in the active (Waiting) list.
    expect(within(screen.getByTestId('section-waiting')).getByText('Ship the widget')).toBeInTheDocument();
    expect(api.ideas.update).not.toHaveBeenCalledWith('i1', expect.objectContaining({ state: 'graduated' }));
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
