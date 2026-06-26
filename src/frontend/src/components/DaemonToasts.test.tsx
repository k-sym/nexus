import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import DaemonToasts from './DaemonToasts';
import type { MissionStatus } from '../api';

function statusWithDeadJobs(dead: number): MissionStatus {
  return {
    memory: {
      ok: true,
      models: { gen: true, embed: true, rerank: true },
      jobs: { pending: 0, dead },
    },
    models: [],
  };
}

describe('DaemonToasts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps a dismissed dead-letter warning hidden after remount', () => {
    const status = statusWithDeadJobs(1);
    const { unmount } = render(<DaemonToasts status={status} />);

    expect(screen.getByText('1 memory job(s) failed (dead-lettered)')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(screen.queryByText('1 memory job(s) failed (dead-lettered)')).not.toBeInTheDocument();

    unmount();
    render(<DaemonToasts status={status} />);

    expect(screen.queryByText('1 memory job(s) failed (dead-lettered)')).not.toBeInTheDocument();
  });

  it('shows the warning again when the dead-letter condition changes', () => {
    const { rerender } = render(<DaemonToasts status={statusWithDeadJobs(1)} />);
    fireEvent.click(screen.getByTitle('Dismiss'));

    rerender(<DaemonToasts status={statusWithDeadJobs(2)} />);

    expect(screen.getByText('2 memory job(s) failed (dead-lettered)')).toBeInTheDocument();
  });
});
