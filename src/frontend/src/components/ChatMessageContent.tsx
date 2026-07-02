import ChatArtifactLinks from './ChatArtifactLinks';

interface ChatMessageContentProps {
  text: string;
  onOpenPath: (path: string) => void;
  /** Linkify file paths in the text runs. Off for user messages (their text
   *  is shown verbatim), on for assistant/tool output — matching prior behavior. */
  linkifyPaths?: boolean;
}

/**
 * Renders chat message text with two enhancements over plain text:
 *  1. Images written as a raw HTML `<img src="https://…">` tag (how GitHub
 *     issue bodies embed user-attachment screenshots) or as a markdown
 *     `![alt](https://…)` are rendered as real <img> elements.
 *  2. Everything else is passed through {@link ChatArtifactLinks}, which
 *     linkifies file paths and otherwise renders escaped text.
 *
 * Only images hosted on GitHub's attachment hosts are turned into images (see
 * {@link isAllowedImageUrl}); every other URL/scheme is left as escaped text,
 * so this is not an arbitrary-HTML sink and does not auto-load arbitrary remote
 * URLs. We only ever emit an <img> whose `src` we control.
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
