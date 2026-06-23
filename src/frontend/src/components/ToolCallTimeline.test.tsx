import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallTimeline } from './ToolCallTimeline';

describe('ToolCallTimeline', () => {
  it('communicates interrupted status with text and supports local expansion', () => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'call-1',
        name: 'Bash',
        args: { command: 'npm test' },
        status: 'interrupted',
        result: 'last output',
      }]}
      detailsExpanded={false}
    />);

    expect(screen.getByText('Interrupted')).toBeVisible();
    const row = screen.getByRole('button', { name: /bash.*npm test/i });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('last output')).toBeVisible();
  });
});
