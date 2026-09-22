import { useEffect, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type FilePreview } from '../api';

interface ArtifactPreviewTabProps {
  projectId: string;
  /** The file to show, set when a path in chat is clicked; null until then. */
  selectedPath: string | null;
}

export default function ArtifactPreviewTab({ projectId, selectedPath }: ArtifactPreviewTabProps) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedPath) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    api.projects.previewFile(projectId, selectedPath)
      .then((next) => {
        if (alive) setPreview(next);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : 'Unable to preview file');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [projectId, selectedPath]);

  if (!selectedPath) {
    return <div className="py-6 text-center text-xs text-faint">Click a file path in the chat to preview it here.</div>;
  }
  const title = preview?.name ?? selectedPath.split('/').pop() ?? 'Preview';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="min-w-0 truncate text-[10px] uppercase tracking-wider text-faint font-medium" title={selectedPath}>{title}</span>
        {preview?.kind === 'pdf' && (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            title="Open preview"
            className="flex shrink-0 items-center gap-1 text-xs text-faint hover:text-[var(--text-primary)] transition-colors"
          >
            <ArrowSquareOut size={14} /> Open
          </a>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="py-6 text-center text-xs text-faint">Loading preview…</div>
        ) : error ? (
          <div className="surface-panel rounded-md border border-subtle p-3 text-xs text-amber-200" role="alert">{error}</div>
        ) : preview ? (
          <PreviewBody preview={preview} />
        ) : null}
      </div>
    </div>
  );
}

function PreviewBody({ preview }: { preview: FilePreview }) {
  if (preview.kind === 'text' && preview.content !== undefined) {
    if (preview.mimeType === 'text/markdown' || /\.md(?:own)?$/i.test(preview.name)) {
      return (
        <div className="chat-markdown surface-panel min-h-full rounded-md border border-subtle p-4 text-sm leading-relaxed text-primary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown>
        </div>
      );
    }
    return (
      <pre className="surface-panel min-h-full whitespace-pre-wrap break-words rounded-md border border-subtle p-3 text-xs leading-relaxed text-primary">
        {preview.content}
      </pre>
    );
  }
  if (preview.kind === 'image' && preview.data) {
    return (
      <img
        src={`data:${preview.mimeType};base64,${preview.data}`}
        alt={preview.name}
        className="w-full rounded-md border border-subtle object-contain"
      />
    );
  }
  if (preview.kind === 'pdf' && preview.url) {
    return (
      <iframe
        title={preview.name}
        src={preview.url}
        className="h-full min-h-[32rem] w-full rounded-md border border-subtle bg-white"
      />
    );
  }
  return (
    <div className="surface-panel rounded-md border border-subtle p-3 text-xs text-muted">
      <div className="font-medium text-primary">{preview.name}</div>
      <div className="mt-1 break-all text-faint">{preview.path}</div>
      <div className="mt-3">No inline preview is available for this file type.</div>
    </div>
  );
}
