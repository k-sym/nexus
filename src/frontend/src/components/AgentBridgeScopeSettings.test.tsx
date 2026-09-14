import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { AgentBridgeScopeSettings } from './AgentBridgeScopeSettings';

vi.mock('../api', () => ({ api: { agentBridge: { projects: vi.fn(), setPolicy: vi.fn() } } }));
const project = { id: 'p', name: 'Nexus', enabled: false, thread_ids: null, threads: [{ id: 'a', title: 'Review' }, { id: 'b', title: 'Build' }] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.agentBridge.projects).mockResolvedValue({ projects: [project] });
  vi.mocked(api.agentBridge.setPolicy).mockImplementation(async (_id, policy) => ({ ...project, ...policy }));
});
it('requires explicit save, persists selected threads, and can return to all threads', async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<AgentBridgeScopeSettings onSaved={onSaved} />);
  const enabled = await screen.findByLabelText('Enable bridge delivery for Nexus');
  const save = screen.getByRole('button', { name: 'Save scope for Nexus' });
  expect(save).toBeDisabled();
  await user.click(enabled);
  await user.selectOptions(screen.getByLabelText('Threads for Nexus'), 'selected');
  expect(screen.getByText(/No threads selected/)).toBeInTheDocument();
  await user.click(screen.getByLabelText('Review'));
  expect(api.agentBridge.setPolicy).not.toHaveBeenCalled();
  await user.click(save);
  await waitFor(() => expect(api.agentBridge.setPolicy).toHaveBeenCalledWith('p', { enabled: true, thread_ids: ['a'] }));
  expect(await screen.findByText('Scope saved.')).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalledOnce();
  expect(save).toBeDisabled();
  await user.selectOptions(screen.getByLabelText('Threads for Nexus'), 'all');
  await user.click(save);
  await waitFor(() => expect(api.agentBridge.setPolicy).toHaveBeenLastCalledWith('p', { enabled: true, thread_ids: null }));
});
it('preserves draft selections when save fails', async () => {
  vi.mocked(api.agentBridge.setPolicy).mockRejectedValue(new Error('Scope could not be saved'));
  const user = userEvent.setup();
  render(<AgentBridgeScopeSettings />);
  await user.click(await screen.findByLabelText('Enable bridge delivery for Nexus'));
  await user.click(screen.getByRole('button', { name: 'Save scope for Nexus' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Scope could not be saved');
  expect(screen.getByLabelText('Enable bridge delivery for Nexus')).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save scope for Nexus' })).toBeEnabled();
});
it('recovers a failed project load', async () => {
  vi.mocked(api.agentBridge.projects).mockRejectedValueOnce(new Error('Offline'));
  const user = userEvent.setup();
  render(<AgentBridgeScopeSettings />);
  await user.click(await screen.findByRole('button', { name: 'Retry loading projects' }));
  expect(await screen.findByLabelText('Enable bridge delivery for Nexus')).toBeInTheDocument();
});
