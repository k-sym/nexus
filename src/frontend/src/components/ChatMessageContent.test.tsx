import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatMessageContent from './ChatMessageContent';

describe('ChatMessageContent', () => {
  it('renders assistant markdown structure instead of literal markdown punctuation', () => {
    const { container } = render(
      <ChatMessageContent
        text={[
          '## Test Coverage',
          '',
          'Two regression tests were added:',
          '',
          '- verify succeeds via admin cookie',
          '- stats accessible via admin cookie',
          '',
          '```php',
          '$middleware->append(InjectBearerFromAdminCookie::class);',
          '```',
        ].join('\n')}
        onOpenPath={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Test Coverage' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(container.querySelector('pre code')).toHaveTextContent(
      '$middleware->append(InjectBearerFromAdminCookie::class);',
    );
    expect(screen.queryByText(/## Test Coverage/)).not.toBeInTheDocument();
    expect(screen.queryByText(/```php/)).not.toBeInTheDocument();
  });

  it('renders GFM task list checkboxes without enabling interaction', () => {
    render(
      <ChatMessageContent
        text={'- [x] customer token cannot hit admin verify\n- [ ] document follow-up'}
        onOpenPath={vi.fn()}
      />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[0]).toBeDisabled();
    expect(checkboxes[1]).not.toBeChecked();
    expect(checkboxes[1]).toBeDisabled();
  });

  it('keeps user messages verbatim when markdown rendering is disabled', () => {
    render(
      <ChatMessageContent
        text={'## Not a heading\n\n```text\nliteral fence\n```'}
        onOpenPath={vi.fn()}
        linkifyPaths={false}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Not a heading' })).not.toBeInTheDocument();
    expect(screen.getByText(/## Not a heading/)).toBeInTheDocument();
    expect(screen.getByText(/```text/)).toBeInTheDocument();
  });

  it('linkifies file paths inside markdown prose', () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageContent
        text={'Open /Users/k-sym/notes.md after reviewing the list.'}
        onOpenPath={onOpenPath}
      />,
    );

    const button = screen.getByRole('button', { name: /Preview notes\.md/ });
    expect(button).toBeInTheDocument();
    button.click();
    expect(onOpenPath).toHaveBeenCalledWith('/Users/k-sym/notes.md');
  });

  it('linkifies artifact paths wrapped in inline code', () => {
    const onOpenPath = vi.fn();
    render(
      <ChatMessageContent
        text={'Created it here: `/Users/k-sym/Projects/nexus/output/stick-man-640x480.png`'}
        onOpenPath={onOpenPath}
      />,
    );

    const button = screen.getByRole('button', { name: /Preview stick-man-640x480\.png/ });
    expect(button).toBeInTheDocument();
    button.click();
    expect(onOpenPath).toHaveBeenCalledWith('/Users/k-sym/Projects/nexus/output/stick-man-640x480.png');
  });

  it('does not trust raw HTML in markdown output', () => {
    const { container } = render(
      <ChatMessageContent
        text={'Hello <script>alert(1)</script><span>raw</span>'}
        onOpenPath={vi.fn()}
      />,
    );

    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<span>raw</span>');
  });

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
