import { useEffect, useState } from 'react';
import { setConfirmListener, type ConfirmRequest } from '../lib/confirm';

/**
 * Single mounted host for confirmDialog(). Renders a modal when a confirmation
 * is pending and resolves the caller's promise with the user's choice. Mount
 * once near the app root. Defaults focus to Cancel and treats Escape / backdrop
 * clicks as "no", since every caller gates a destructive action.
 */
export default function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    setConfirmListener(setRequest);
    return () => setConfirmListener(null);
  }, []);

  useEffect(() => {
    if (!request) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') request.resolve(false);
      else if (ev.key === 'Enter') request.resolve(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => request.resolve(false)}
    >
      <div
        className="surface-glass border border-subtle rounded-xl w-full max-w-sm p-6"
        onClick={(ev) => ev.stopPropagation()}
      >
        <p className="text-sm text-primary">{request.message}</p>
        <div className="flex justify-end gap-2 pt-5">
          <button
            type="button"
            autoFocus
            onClick={() => request.resolve(false)}
            className="px-4 py-2 text-sm text-muted hover:text-[var(--text-primary)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => request.resolve(true)}
            className="px-4 py-2 text-sm accent-button rounded-lg transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
