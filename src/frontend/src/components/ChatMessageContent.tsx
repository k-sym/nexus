import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatArtifactLinks, { containsArtifactPath } from './ChatArtifactLinks';

interface ChatMessageContentProps {
  text: string;
  onOpenPath: (path: string) => void;
  /** Linkify file paths in the text runs. Off for user messages (their text
   *  is shown verbatim), on for assistant/tool output — matching prior behavior. */
  linkifyPaths?: boolean;
}

/**
 * Renders assistant/tool output as constrained Markdown. Raw HTML is not
 * enabled; links and images are emitted only through explicit component
 * overrides, and local file paths still go through {@link ChatArtifactLinks}.
 */

type Token =
  | { type: 'text'; text: string }
  | { type: 'image'; src: string; alt: string };

// Raw HTML <img …> tag — capture the whole tag so we can pull src/alt out of it.
const HTML_IMG = /<img\b[^>]*>/gi;
// Markdown image: ![alt](url)
const MD_IMG = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/gi;

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m?.[1];
}

/**
 * Only auto-render images from GitHub's attachment hosts. This covers the
 * reported case (issue-body screenshots embedded as `<img>`/markdown) while
 * NOT auto-loading arbitrary remote URLs a user might paste — which would leak
 * their IP/timing to that host (tracking-beacon risk). Non-allowlisted URLs
 * fall through and render as plain (escaped) text / file links.
 */
function isAllowedImageUrl(url: string | undefined): url is string {
  if (typeof url !== 'string') return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'github.com' ||
    host === 'www.github.com' ||
    host === 'githubusercontent.com' ||
    host.endsWith('.githubusercontent.com')
  );
}

function isAllowedLinkUrl(url: string | undefined): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function escapeMarkdownImageAlt(alt: string): string {
  return alt.replace(/\r?\n/g, ' ').replace(/]/g, '\\]');
}

function normalizeAllowedRawImages(text: string): string {
  return text.replace(HTML_IMG, (tag) => {
    const src = attr(tag, 'src');
    if (!isAllowedImageUrl(src)) return tag;
    const alt = escapeMarkdownImageAlt(attr(tag, 'alt') ?? '');
    return `![${alt}](${src})`;
  });
}

/** Split message text into image tokens and the text between them. */
function tokenize(text: string): Token[] {
  type Hit = { start: number; end: number; src: string; alt: string };
  const hits: Hit[] = [];

  for (const m of text.matchAll(HTML_IMG)) {
    const tag = m[0];
    const src = attr(tag, 'src');
    if (!isAllowedImageUrl(src)) continue; // non-allowlisted URLs fall through to text
    hits.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + tag.length,
      src,
      alt: attr(tag, 'alt') ?? '',
    });
  }
  for (const m of text.matchAll(MD_IMG)) {
    const src = m[2];
    if (!isAllowedImageUrl(src)) continue;
    hits.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      src,
      alt: m[1] ?? '',
    });
  }

  hits.sort((a, b) => a.start - b.start);

  const tokens: Token[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // overlapping match, skip
    if (hit.start > cursor) tokens.push({ type: 'text', text: text.slice(cursor, hit.start) });
    tokens.push({ type: 'image', src: hit.src, alt: hit.alt });
    cursor = hit.end;
  }
  if (cursor < text.length) tokens.push({ type: 'text', text: text.slice(cursor) });
  return tokens;
}

export default function ChatMessageContent({ text, onOpenPath, linkifyPaths = true }: ChatMessageContentProps) {
  const renderText = (runText: string, key: string) =>
    linkifyPaths ? (
      <ChatArtifactLinks key={key} text={runText} onOpenPath={onOpenPath} />
    ) : (
      <span key={key}>{runText}</span>
    );

  if (linkifyPaths) {
    const renderLinkedChildren = (children: React.ReactNode) => (
      <>
        {React.Children.map(children, (child, index) =>
          typeof child === 'string' ? (
            <ChatArtifactLinks key={`artifact-text-${index}`} text={child} onOpenPath={onOpenPath} />
          ) : (
            child
          ),
        )}
      </>
    );

    const components: Components = {
      a({ href, children }) {
        if (!isAllowedLinkUrl(href)) {
          return <span>{children}</span>;
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="accent-text underline decoration-[var(--border-strong)] underline-offset-2 transition-colors hover:text-[var(--accent)]"
          >
            {children}
          </a>
        );
      },
      blockquote({ children }) {
        return <blockquote className="border-l-2 border-subtle pl-3 text-muted">{children}</blockquote>;
      },
      code({ className, children }) {
        const hasLanguage = typeof className === 'string' && className.startsWith('language-');
        const codeText = String(children);
        const hasNewline = codeText.includes('\n');
        if (!hasLanguage && !hasNewline && containsArtifactPath(codeText)) {
          return <ChatArtifactLinks text={codeText} onOpenPath={onOpenPath} />;
        }
        return (
          <code className={hasLanguage || hasNewline ? className : 'rounded border border-subtle bg-zinc-950/45 px-1 py-0.5 text-[0.92em] accent-text'}>
            {children}
          </code>
        );
      },
      h1({ children }) {
        return <h1>{renderLinkedChildren(children)}</h1>;
      },
      h2({ children }) {
        return <h2>{renderLinkedChildren(children)}</h2>;
      },
      h3({ children }) {
        return <h3>{renderLinkedChildren(children)}</h3>;
      },
      h4({ children }) {
        return <h4>{renderLinkedChildren(children)}</h4>;
      },
      img({ src, alt }) {
        if (!isAllowedImageUrl(src)) {
          return <span>{src ? `![${alt ?? ''}](${src})` : alt}</span>;
        }
        return (
          <a
            href={src}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 block"
          >
            <img
              src={src}
              alt={alt || 'Attached image'}
              loading="lazy"
              className="max-h-80 max-w-full rounded-lg border border-subtle object-contain"
            />
          </a>
        );
      },
      input(props) {
        return <input {...props} disabled className="mr-2 align-middle accent-[var(--accent)]" />;
      },
      li({ children }) {
        return <li>{renderLinkedChildren(children)}</li>;
      },
      p({ children }) {
        return <p>{renderLinkedChildren(children)}</p>;
      },
      pre({ children }) {
        return (
          <pre className="max-w-full overflow-x-auto rounded-lg border border-subtle bg-zinc-950/55 p-3 text-xs leading-relaxed text-zinc-100">
            {children}
          </pre>
        );
      },
      strong({ children }) {
        return <strong>{renderLinkedChildren(children)}</strong>;
      },
      td({ children }) {
        return <td>{renderLinkedChildren(children)}</td>;
      },
      th({ children }) {
        return <th>{renderLinkedChildren(children)}</th>;
      },
    };

    return (
      <div className="chat-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {normalizeAllowedRawImages(text)}
        </ReactMarkdown>
      </div>
    );
  }

  // Cheap short-circuit: the vast majority of messages contain no image
  // markup, so skip the regex scans + allocations entirely for them.
  if (!text.includes('<img') && !text.includes('![')) {
    return renderText(text, 'text-0');
  }

  const tokens = tokenize(text);
  const hasImage = tokens.some((t) => t.type === 'image');
  if (!hasImage) {
    // Had image-like markup but nothing allowlisted — render as text.
    return renderText(text, 'text-0');
  }

  return (
    <>
      {tokens.map((token, index) =>
        token.type === 'image' ? (
          <a
            key={`img-${index}`}
            href={token.src}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 block"
          >
            <img
              src={token.src}
              alt={token.alt || 'Attached image'}
              loading="lazy"
              className="max-h-80 max-w-full rounded-lg border border-subtle object-contain"
            />
          </a>
        ) : token.text.trim() === '' ? (
          <span key={`text-${index}`}>{token.text}</span>
        ) : (
          renderText(token.text, `text-${index}`)
        ),
      )}
    </>
  );
}
