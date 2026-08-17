import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThinkingSelector } from './ThinkingSelector';

describe('ThinkingSelector', () => {
  it('returns null when there are no levels', () => {
    const { container } = render(
      <ThinkingSelector levels={[]} value="auto" onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the current thinking label', () => {
    render(
      <ThinkingSelector levels={['off', 'high']} value="high" onChange={() => {}} />,
    );
    expect(screen.getByTestId('thinking-selector')).toHaveTextContent('Thinking: High');
  });

  it('offers Auto separately from an explicit Off', async () => {
    render(
      <ThinkingSelector levels={['off', 'high']} value="auto" onChange={() => {}} />,
    );
    expect(screen.getByTestId('thinking-selector')).toHaveTextContent('Thinking: Auto');
    await userEvent.click(screen.getByTestId('thinking-selector'));
    expect(screen.getByRole('option', { name: 'Auto' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Off' })).toBeInTheDocument();
  });

  it('lists levels and reports selection', async () => {
    const onChange = vi.fn();
    render(
      <ThinkingSelector levels={['off', 'medium', 'high']} value="off" onChange={onChange} />,
    );
    await userEvent.click(screen.getByTestId('thinking-selector'));
    const list = screen.getByTestId('thinking-dropdown-list');
    expect(list).toHaveTextContent('Medium');
    await userEvent.click(screen.getByRole('option', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('does not open when disabled', async () => {
    render(
      <ThinkingSelector levels={['off', 'high']} value="off" onChange={() => {}} disabled />,
    );
    await userEvent.click(screen.getByTestId('thinking-selector'));
    expect(screen.queryByTestId('thinking-dropdown-list')).not.toBeInTheDocument();
  });
});
