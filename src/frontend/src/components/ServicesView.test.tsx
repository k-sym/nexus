import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ServicesView from './ServicesView';
import type { DockerServicesResponse } from '../api';

const { fetchDockerServices, dockerServiceDown, confirmDialog } = vi.hoisted(() => ({
  fetchDockerServices: vi.fn(),
  dockerServiceDown: vi.fn(),
  confirmDialog: vi.fn(),
}));

vi.mock('../api', () => ({ fetchDockerServices, dockerServiceDown }));
vi.mock('../lib/confirm', () => ({ confirmDialog }));

// Orphans first, as the backend sorts them.
const ORPHAN_GROUP = {
  project: 'nexus-thread-gone',
  orphaned: true,
  containers: [{ name: 'nexus-thread-gone-web-1', image: 'nginx:alpine', state: 'exited', status: 'Exited (0)', ports: '' }],
};
const LIVE_GROUP = {
  project: 'nexus-thread-live',
  orphaned: false,
  containers: [{ name: 'nexus-thread-live-db-1', image: 'postgres:16', state: 'running', status: 'Up 2 min', ports: '0.0.0.0:5432->5432/tcp' }],
};
const response = (over: Partial<DockerServicesResponse> = {}): DockerServicesResponse => ({
  available: true,
  groups: [ORPHAN_GROUP, LIVE_GROUP],
  ...over,
});

describe('ServicesView', () => {
  beforeEach(() => {
    fetchDockerServices.mockReset().mockResolvedValue(response());
    dockerServiceDown.mockReset().mockResolvedValue(undefined);
    confirmDialog.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders each project with its containers, ports, and the orphaned flag', async () => {
    render(<ServicesView />);

    expect(await screen.findByText('thread-live')).toBeInTheDocument();
    expect(screen.getByText('thread-gone')).toBeInTheDocument();
    expect(screen.getByText('0.0.0.0:5432->5432/tcp')).toBeInTheDocument();
    // The leak is called out — the per-group badge and the header summary.
    expect(screen.getAllByText(/orphaned/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/1 orphaned/)).toBeInTheDocument();
  });

  it('tears a group down after confirmation, then refreshes', async () => {
    render(<ServicesView />);
    await screen.findByText('thread-gone');

    // After teardown the refresh returns only the live group.
    fetchDockerServices.mockResolvedValue(response({ groups: [LIVE_GROUP] }));
    // The orphan sorts first, so its Tear down button is [0].
    fireEvent.click(screen.getAllByText('Tear down')[0]);

    await waitFor(() => expect(dockerServiceDown).toHaveBeenCalledWith('nexus-thread-gone'));
    await waitFor(() => expect(screen.queryByText('thread-gone')).not.toBeInTheDocument());
  });

  it('does not tear down when the confirmation is declined', async () => {
    confirmDialog.mockResolvedValue(false);
    render(<ServicesView />);
    await screen.findByText('thread-gone');

    fireEvent.click(screen.getAllByText('Tear down')[0]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(dockerServiceDown).not.toHaveBeenCalled();
  });

  it('shows a Docker-unavailable message instead of an empty list', async () => {
    fetchDockerServices.mockResolvedValue({ available: false, groups: [] });
    render(<ServicesView />);
    expect(await screen.findByText(/Docker isn't reachable/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is running', async () => {
    fetchDockerServices.mockResolvedValue({ available: true, groups: [] });
    render(<ServicesView />);
    expect(await screen.findByText(/No services are running/)).toBeInTheDocument();
  });

  it('on a fetch error shows the error alone, not a misleading empty state', async () => {
    fetchDockerServices.mockRejectedValue(new Error('network down'));
    render(<ServicesView />);
    expect(await screen.findByText(/Could not reach the backend/)).toBeInTheDocument();
    // We couldn't read the list, so we must not claim nothing is running.
    expect(screen.queryByText(/No services are running/)).not.toBeInTheDocument();
  });
});
