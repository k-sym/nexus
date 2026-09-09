import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SelectMenu from './SelectMenu';

const options = [
  { value: 'a', label: 'Alpha', hint: '/a' },
  { value: 'b', label: 'Beta' },
];

describe('SelectMenu', () => {
  it('shows the current label, opens a listbox, and reports the pick', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SelectMenu label="Project" value="a" options={options} onChange={onChange} />);

    const trigger = screen.getByRole('button', { name: 'Project' });
    expect(trigger).toHaveTextContent('Alpha');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: /Alpha/ })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the placeholder when nothing matches and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<SelectMenu label="Model" value="" options={options} onChange={vi.fn()} placeholder="Pick a model" />);
    const trigger = screen.getByRole('button', { name: 'Model' });
    expect(trigger).toHaveTextContent('Pick a model');
    await user.click(trigger);
    expect(screen.getByRole('listbox', { name: 'Model' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
