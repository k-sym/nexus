import { FileText } from '@phosphor-icons/react';

interface ChatArtifactLinksProps {
  text: string;
  onOpenPath: (path: string) => void;
}

const PREVIEW_EXTENSIONS = 'md|txt|pdf|png|jpe?g|gif|webp|csv|tsv|json|ya?ml|docx?|xlsx?';
const FILE_PATH_PATTERN = new RegExp(
  `(^|[\\s("'\`\\[])(` +
    `file:\\/\\/\\/[^\\s<>"'\`]+|` +
    `\\/(?:Users|private|tmp|var|Volumes)\\/[^\\s<>"'\`]+?\\.(?:${PREVIEW_EXTENSIONS})|` +
    `(?:\\.{1,2}\\/)?(?:[A-Za-z0-9_@.+-]+\\/)*[A-Za-z0-9_@.+-]+?\\.(?:${PREVIEW_EXTENSIONS})` +
  `)`,
  'gi',
);

export function containsArtifactPath(text: string): boolean {
  FILE_PATH_PATTERN.lastIndex = 0;
  return FILE_PATH_PATTERN.test(text);
}

function displayName(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0];
  const normalized = withoutQuery.startsWith('file://') ? decodeURIComponent(withoutQuery.replace(/^file:\/\//, '')) : withoutQuery;
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export default function ChatArtifactLinks({ text, onOpenPath }: ChatArtifactLinksProps) {
  const parts: Array<{ type: 'text'; text: string } | { type: 'path'; path: string }> = [];
  let lastIndex = 0;
  FILE_PATH_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    const prefix = match[1] ?? '';
    const matchedPath = match[2] ?? '';
    const raw = matchedPath.replace(/[.,;:]+$/, '');
    const index = (match.index ?? 0) + prefix.length;
    if (index > lastIndex) parts.push({ type: 'text', text: text.slice(lastIndex, index) });
    parts.push({ type: 'path', path: raw });
    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) });
  if (parts.length === 0) return <>{text}</>;

  return (
    <>
      {parts.map((part, index) => part.type === 'text' ? (
        <span key={`text-${index}`}>{part.text}</span>
      ) : (
        <button
          key={`path-${index}`}
          type="button"
          onClick={() => onOpenPath(part.path)}
          aria-label={`Preview ${displayName(part.path)}`}
          title={part.path}
          className="mx-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border border-subtle bg-zinc-950/35 px-1.5 py-0.5 align-baseline text-xs accent-text hover:border-[var(--border-strong)] transition-colors"
        >
          <FileText size={13} />
          <span className="truncate">{displayName(part.path)}</span>
        </button>
      ))}
    </>
  );
}
