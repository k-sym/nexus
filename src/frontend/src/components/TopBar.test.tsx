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
});
