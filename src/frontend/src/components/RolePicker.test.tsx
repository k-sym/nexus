import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_MODELS } from '@nexus/shared';
import RolePicker, { RoleRoster } from './RolePicker';
import { api } from '../api';
vi.mock('../api', () => ({ api: { roles: { get: vi.fn(), update: vi.fn() } } }));
vi.mock('../hooks/useModels', () => ({ useModels: () => ({ allModels: [
  { provider: 'openai', id: 'gpt-5.6-sol', name: 'Sol', configured: true },
  { provider: 'openrouter', id: 'z-ai/glm-5.2', name: 'GLM', configured: false },
] }) }));
it('lists the whole catalog for every role, preserving unavailable selections', async () => {
  const onChange = vi.fn();
  render(<RoleRoster value={{ scout: 'retired/model' }} onChange={onChange} />);
  const picker = screen.getByLabelText('scout model');
  expect(picker).toHaveValue('retired/model');
  expect(screen.getAllByRole('option', { name: /GLM.*unavailable/ })).toHaveLength(5);
  await userEvent.selectOptions(picker, 'openai/gpt-5.6-sol');
  expect(onChange).toHaveBeenCalledWith({ scout: 'openai/gpt-5.6-sol' });
});
it('persists and resets a thread override', async () => {
  const view = { enabled: true, defaults: DEFAULT_ROLE_MODELS, effective: DEFAULT_ROLE_MODELS, overrides: {}, available: {} };
  vi.mocked(api.roles.get).mockResolvedValue(view as any);
  vi.mocked(api.roles.update).mockResolvedValue({ ...view, overrides: { refuter: 'openai/gpt-5.6-sol' } } as any);
  render(<RolePicker threadId="t" />);
  await userEvent.click(await screen.findByText('Roles'));
  await userEvent.selectOptions(screen.getByLabelText('refuter model'), 'openai/gpt-5.6-sol');
  await waitFor(() => expect(api.roles.update).toHaveBeenCalledWith('t', expect.objectContaining({ refuter: 'openai/gpt-5.6-sol' })));
  await waitFor(() => expect(screen.getByLabelText('refuter model')).not.toBeDisabled());
  await userEvent.selectOptions(screen.getByLabelText('refuter model'), '');
  expect(api.roles.update).toHaveBeenLastCalledWith('t', expect.objectContaining({ refuter: null }));
});
