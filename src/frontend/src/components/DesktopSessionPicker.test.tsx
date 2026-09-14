import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DesktopSessionPicker } from './DesktopSessionPicker';
import * as api from '../api';

const sessions = [
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Fix the badge', first_prompt: 'Fix the badge please', last_modified: new Date().toISOString(), created_at: null, git_branch: 'main', cwd: '/repo' },
  { id: 'aaaaaaaa-0000-0000-0000-000000000002', title: 'Older work', first_prompt: null, last_modified: new Date(Date.now() - 86_400_000 * 3).toISOString(), created_at: null, git_branch: null, cwd: '/repo' },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('DesktopSessionPicker', () => {
  it('lists sessions, filters by title, and imports the chosen one', async () => {
    vi.spyOn(api.api.projects, 'desktopSessions').mockResolvedValue({ sessions, desktop: { appFound: true, indexFound: true } });
    const onImport = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<DesktopSessionPicker projectId="p1" onImport={onImport} onClose={onClose} />);

    expect(await screen.findByText('Fix the badge')).toBeInTheDocument();
    expect(screen.getByText('Older work')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'older' } });
    expect(screen.queryByText('Fix the badge')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Older work'));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(sessions[1]));
  });

  it('shows the import error and the empty state', async () => {
    vi.spyOn(api.api.projects, 'desktopSessions').mockResolvedValue({ sessions, desktop: { appFound: false, indexFound: false } });
    const onImport = vi.fn(async () => { throw new Error('That session is already on the board'); });
    render(<DesktopSessionPicker projectId="p1" onImport={onImport} onClose={() => {}} />);
    await screen.findByText('Fix the badge');
    expect(screen.getByText(/Claude Desktop not found here/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Fix the badge'));
    expect(await screen.findByText('That session is already on the board')).toBeInTheDocument();
  });

  it('explains when the repo path has no sessions', async () => {
    vi.spyOn(api.api.projects, 'desktopSessions').mockResolvedValue({ sessions: [], desktop: { appFound: true, indexFound: true } });
    render(<DesktopSessionPicker projectId="p1" onImport={async () => {}} onClose={() => {}} />);
    expect(await screen.findByText(/No Claude Desktop or terminal sessions/)).toBeInTheDocument();
  });
});
