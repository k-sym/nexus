import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatMessageContent from './ChatMessageContent';

describe('ChatMessageContent', () => {
  it('renders a raw GitHub <img> tag as an image element', () => {
    const text =
      'Login is OK, but anything after that fails.\n\n' +
      '<img width="806" height="409" alt="Screenshot" src="https://github.com/user-attachments/assets/abc-123" />';
    render(<ChatMessageContent text={text} onOpenPath={vi.fn()} />);
    const img = screen.getByRole('img', { name: 'Screenshot' });
    expect(img).toHaveAttribute('src', 'https://github.com/user-attachments/assets/abc-123');
    // The surrounding prose is still shown.
    expect(screen.getByText(/Login is OK/)).toBeInTheDocument();
    // The raw HTML tag must NOT leak into the page as literal text.
    expect(screen.queryByText(/<img/)).not.toBeInTheDocument();
  });

  it('renders a markdown image from a GitHub host as an image element', () => {
    render(
      <ChatMessageContent
        text={'Here:\n![diagram](https://private-user-images.githubusercontent.com/1/pic.png)'}
        onOpenPath={vi.fn()}
      />,
    );
    const img = screen.getByRole('img', { name: 'diagram' });
    expect(img).toHaveAttribute('src', 'https://private-user-images.githubusercontent.com/1/pic.png');
  });

  it('does NOT render non-https image sources (leaves them as text)', () => {
    const text = '<img src="javascript:alert(1)" alt="x" /> and <img src="http://insecure/p.png" alt="y" />';
    render(<ChatMessageContent text={text} onOpenPath={vi.fn()} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('does NOT auto-load https images from non-GitHub hosts (beacon protection)', () => {
    const text = 'look <img src="https://evil.example/beacon.png" alt="pixel" /> and ![x](https://cdn.example/y.png)';
    render(<ChatMessageContent text={text} onOpenPath={vi.fn()} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('still linkifies file paths in the remaining text', () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageContent
        text={'See /Users/k-sym/notes.md for details.'}
        onOpenPath={onOpenPath}
      />,
    );
    expect(screen.getByRole('button', { name: /Preview notes\.md/ })).toBeInTheDocument();
  });

  it('with linkifyPaths=false: renders images but leaves file paths as text', () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageContent
        text={'See /Users/k-sym/notes.md\n<img src="https://github.com/user-attachments/assets/z" alt="shot" />'}
        onOpenPath={onOpenPath}
        linkifyPaths={false}
      />,
    );
    expect(screen.getByRole('img', { name: 'shot' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Preview/ })).not.toBeInTheDocument();
    expect(screen.getByText(/notes\.md/)).toBeInTheDocument();
  });

  it('renders plain text unchanged when there are no images', () => {
    render(<ChatMessageContent text={'just a normal message'} onOpenPath={vi.fn()} />);
    expect(screen.getByText('just a normal message')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
