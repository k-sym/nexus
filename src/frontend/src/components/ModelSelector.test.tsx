import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

const models = [
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', configured: false },
  { id: 'glm-4.6', name: 'GLM 4.6', provider: 'opencode-go', configured: true },
];

describe('ModelSelector', () => {
  it('renders the active model name when one is selected', () => {
    render(
      <ModelSelector
        models={models}
        currentModelId="anthropic/claude-sonnet-4-5"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('Sonnet 4.5')).toBeInTheDocument();
  });

  it('shows a placeholder when no model is selected', () => {
    render(<ModelSelector models={models} onSelect={() => {}} />);
    expect(screen.getByText('Pick a model')).toBeInTheDocument();
  });

  it('opens the dropdown on click and shows all models', async () => {
    render(
      <ModelSelector
        models={models}
        currentModelId="anthropic/claude-sonnet-4-5"
        onSelect={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText('GPT-5')).toBeInTheDocument();
    expect(screen.getByText('GLM 4.6')).toBeInTheDocument();
  });

  it('calls onSelect with provider + id when a model is picked', async () => {
    const onSelect = vi.fn();
    render(
      <ModelSelector
        models={models}
        currentModelId="anthropic/claude-sonnet-4-5"
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    await userEvent.click(screen.getByText('GPT-5'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-5');
  });

  it('filters by free-text search', async () => {
    render(
      <ModelSelector
        models={models}
        currentModelId="anthropic/claude-sonnet-4-5"
        onSelect={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    const search = screen.getByPlaceholderText(/Search models/i);
    fireEvent.change(search, { target: { value: 'open' } });
    const list = screen.getByTestId('model-dropdown-list');
    // "Sonnet 4.5" is the current model shown on the TRIGGER button.
    // The dropdown list should not include it after the "open" filter.
    expect(within(list).queryByText('Sonnet 4.5')).not.toBeInTheDocument();
    expect(within(list).getByText('GPT-5')).toBeInTheDocument();
  });

  it('marks unconfigured models', async () => {
    render(
      <ModelSelector
        models={models}
        currentModelId="anthropic/claude-sonnet-4-5"
        onSelect={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getAllByText(/no auth/).length).toBeGreaterThanOrEqual(1);
  });

  it('is disabled when the disabled prop is set', () => {
    render(<ModelSelector models={models} onSelect={() => {}} disabled />);
    const trigger = screen.getByRole('button');
    expect(trigger).toBeDisabled();
  });
});
