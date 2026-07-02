import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TopBar from './TopBar';

describe('TopBar', () => {
  it('renders the Assistant global tab and selects it', () => {
    const onSelectGlobal = vi.fn();
    render(
      <TopBar
        view="dashboard"
        onSelectGlobal={onSelectGlobal}
        onSelectManage={vi.fn()}
        onOpenPalette={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Assistant/i }));

    expect(onSelectGlobal).toHaveBeenCalledWith('assistant');
  });

  it('shows an activity dot on the Assistant tab when assistantActive is true', () => {
    render(
      <TopBar
        view="dashboard"
        onSelectGlobal={vi.fn()}
        onSelectManage={vi.fn()}
        onOpenPalette={vi.fn()}
        assistantActive={true}
      />,
    );

    expect(screen.getByLabelText('Assistant run active')).toBeInTheDocument();
  });

  it('hides the activity dot on the Assistant tab when assistantActive is false', () => {
    render(
      <TopBar
        view="dashboard"
        onSelectGlobal={vi.fn()}
        onSelectManage={vi.fn()}
        onOpenPalette={vi.fn()}
        assistantActive={false}
      />,
    );

    expect(screen.queryByLabelText('Assistant run active')).not.toBeInTheDocument();
  });

  it('hides the activity dot on the Assistant tab when assistantActive is omitted', () => {
    render(
      <TopBar
        view="dashboard"
        onSelectGlobal={vi.fn()}
        onSelectManage={vi.fn()}
        onOpenPalette={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Assistant run active')).not.toBeInTheDocument();
  });
});
