import { useEffect, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type FilePreview } from '../api';
import RightRail from './RightRail';

interface ArtifactPreviewRailProps {
  projectId: string;
  selectedPath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ArtifactPreviewRail({ projectId, selectedPath, open, onOpenChange }: ArtifactPreviewRailProps) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedPath || !open) return;
    let alive = true;
    setLoading(true);
    setError(null);
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
  }, [open, projectId, selectedPath]);

  if (!selectedPath) return null;
  const title = preview?.name ?? selectedPath.split('/').pop() ?? 'Preview';

  return (
    <RightRail
      label="Preview"
      title={title}
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="File preview"
      resizable
      actions={preview?.kind === 'pdf' ? (
        <a
          href={preview.url}
          target="_blank"
          rel="noreferrer"
          title="Open preview"
          className="flex items-center gap-1 text-xs text-faint hover:text-[var(--text-primary)] transition-colors"
        >
          <ArrowSquareOut size={14} /> Open
        </a>
      ) : null}
    >
      {loading ? (
        <div className="py-6 text-center text-xs text-faint">Loading preview…</div>
      ) : error ? (
        <div className="surface-panel rounded-md border border-subtle p-3 text-xs text-amber-200" role="alert">{error}</div>
      ) : preview ? (
        <PreviewBody preview={preview} />
      ) : (
        <div className="py-6 text-center text-xs text-faint">Select a file to preview.</div>
      )}
    </RightRail>
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
