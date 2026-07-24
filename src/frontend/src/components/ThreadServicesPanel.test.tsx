import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadServicesPanel from './ThreadServicesPanel';
import type { DockerServicesResponse } from '../api';

const { fetchDockerServices, dockerServiceDown, confirmDialog } = vi.hoisted(() => ({
  fetchDockerServices: vi.fn(),
  dockerServiceDown: vi.fn(),
  confirmDialog: vi.fn(),
}));
vi.mock('../api', () => ({ fetchDockerServices, dockerServiceDown }));
vi.mock('../lib/confirm', () => ({ confirmDialog }));

const withServices = (): DockerServicesResponse => ({
  available: true,
  groups: [{
    project: 'nexus-thread-1',
    orphaned: false,
    containers: [
      { name: 'nexus-thread-1-db-1', image: 'postgres:16', state: 'running', status: 'Up 2m', ports: '0.0.0.0:5432->5432/tcp' },
      { name: 'nexus-thread-1-cache-1', image: 'redis', state: 'exited', status: 'Exited (0)', ports: '' },
    ],
  }],
});

describe('ThreadServicesPanel', () => {
  beforeEach(() => {
    fetchDockerServices.mockReset().mockResolvedValue({ available: true, groups: [] });
    dockerServiceDown.mockReset().mockResolvedValue(undefined);
    confirmDialog.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing when the thread has no services', async () => {
    const { container } = render(<ThreadServicesPanel threadId="thread-1" />);
    await waitFor(() => expect(fetchDockerServices).toHaveBeenCalledWith('thread-1'));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is no thread', () => {
    const { container } = render(<ThreadServicesPanel threadId={null} />);
    expect(container.firstChild).toBeNull();
    expect(fetchDockerServices).not.toHaveBeenCalled();
  });

  it('shows this thread\'s containers, ports, and running count', async () => {
    fetchDockerServices.mockResolvedValue(withServices());
    render(<ThreadServicesPanel threadId="thread-1" />);

    expect(await screen.findByText('nexus-thread-1-db-1')).toBeInTheDocument();
    expect(screen.getByText('0.0.0.0:5432->5432/tcp')).toBeInTheDocument();
    // 1 of 2 running.
    expect(screen.getByText('1/2 running')).toBeInTheDocument();
  });

  it('tears down after confirmation and passes the thread on fetch', async () => {
    fetchDockerServices.mockResolvedValue(withServices());
    render(<ThreadServicesPanel threadId="thread-1" />);
    await screen.findByText('nexus-thread-1-db-1');

    // Only this thread's services are requested.
    expect(fetchDockerServices).toHaveBeenCalledWith('thread-1');

    fireEvent.click(screen.getByText('Tear down'));
    await waitFor(() => expect(dockerServiceDown).toHaveBeenCalledWith('nexus-thread-1'));
  });

  it('does not tear down when confirmation is declined', async () => {
    confirmDialog.mockResolvedValue(false);
    fetchDockerServices.mockResolvedValue(withServices());
    render(<ThreadServicesPanel threadId="thread-1" />);
    await screen.findByText('nexus-thread-1-db-1');

    fireEvent.click(screen.getByText('Tear down'));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(dockerServiceDown).not.toHaveBeenCalled();
  });
});
