/**
 * Shared composer-attachment machinery for assistant-session surfaces.
 *
 * Extracted from AssistantView so the Ideas thread (#352 attachments) reuses
 * the exact same MIME validation, 5-file cap, base64 encoding, warning copy,
 * and pending-chip rendering rather than forking them. ChatPanel keeps its own
 * copy for now (its ChatAttachment wire type differs).
 */
import { useCallback, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { AssistantAttachment } from '../hooks/useAssistantStream';

export const MAX_PENDING_ATTACHMENTS = 5;

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SUPPORTED_FILE_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function inferMimeType(file: File): string {
  if (file.type) return file.type;
  const lowerName = file.name.toLowerCase();
  const extension = Object.keys(EXTENSION_MIME_TYPES).find((ext) => lowerName.endsWith(ext));
  return extension ? EXTENSION_MIME_TYPES[extension] : '';
}

export function isSupportedAttachment(file: File): boolean {
  const mimeType = inferMimeType(file);
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || SUPPORTED_FILE_MIME_TYPES.has(mimeType);
}

export function fileToAttachment(file: File): Promise<AssistantAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      const mimeType = inferMimeType(file);
      resolve({
        type: SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ? 'image' : 'file',
        data: comma >= 0 ? result.slice(comma + 1) : result,
        mimeType,
        name: file.name,
        size: file.size,
      } as AssistantAttachment);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment.'));
    reader.readAsDataURL(file);
  });
}

export function fileExtensionLabel(name?: string): string {
  if (!name || !name.includes('.')) return 'file';
  return name.split('.').pop()?.slice(0, 5) || 'file';
}

/** Pending-attachment composer state: validation, cap, and warning copy. */
export function usePendingAttachments() {
  const [pendingAttachments, setPendingAttachments] = useState<AssistantAttachment[]>([]);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);

  const addAttachmentFiles = useCallback(async (files: File[]) => {
    const supportedFiles = files.filter(isSupportedAttachment);
    const rejected = files.length - supportedFiles.length;
    const slots = Math.max(0, MAX_PENDING_ATTACHMENTS - pendingAttachments.length);
    const accepted = supportedFiles.slice(0, slots);
    const overLimit = supportedFiles.length > slots;

    if (rejected > 0) {
      setAttachmentWarning('Attach images, PDFs, text, Word, Excel, or CSV files.');
    } else if (overLimit) {
      setAttachmentWarning(`Only ${MAX_PENDING_ATTACHMENTS} files can be attached to one message.`);
    } else {
      setAttachmentWarning(null);
    }

    if (accepted.length === 0) return;
    try {
      const attachments = await Promise.all(accepted.map(fileToAttachment));
      setPendingAttachments((current) => [...current, ...attachments].slice(0, MAX_PENDING_ATTACHMENTS));
    } catch (err) {
      setAttachmentWarning(err instanceof Error ? err.message : 'Failed to read attachment.');
    }
  }, [pendingAttachments.length]);

  const removePendingAttachment = useCallback((index: number) => {
    setPendingAttachments((current) => current.filter((_, i) => i !== index));
    setAttachmentWarning(null);
  }, []);

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments([]);
    setAttachmentWarning(null);
  }, []);

  return {
    pendingAttachments,
    attachmentWarning,
    setAttachmentWarning,
    addAttachmentFiles,
    removePendingAttachment,
    clearPendingAttachments,
  };
}

export function AttachmentChip({
  attachment,
  index,
  onRemove,
}: {
  attachment: AssistantAttachment;
  index: number;
  onRemove: (index: number) => void;
}) {
  return (
    <div
      data-testid="pending-assistant-attachment"
      className={`relative rounded-md overflow-hidden border border-subtle surface-elevated shrink-0 ${
        attachment.type === 'image' ? 'w-20 h-16' : 'min-w-36 max-w-52 h-16 px-2 py-2'
      }`}
    >
      {attachment.type === 'image' ? (
        <img
          src={`data:${attachment.mimeType};base64,${attachment.data}`}
          alt={attachment.name ?? `Image ${index + 1}`}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex h-full items-center gap-2 pr-6">
          <span className="rounded-sm border border-subtle px-1.5 py-0.5 text-[10px] uppercase text-muted">
            {fileExtensionLabel(attachment.name)}
          </span>
          <span className="truncate text-xs text-primary">{attachment.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="absolute right-1 top-1 w-5 h-5 rounded-full bg-zinc-950/85 text-xs text-primary flex items-center justify-center"
        aria-label={`Remove ${attachment.name ?? `attachment ${index + 1}`}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}
