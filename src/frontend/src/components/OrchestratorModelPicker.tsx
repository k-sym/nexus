/**
 * OrchestratorModelPicker — modal invoked when a Kanban task moves
 * to "In Progress". The user picks a model; the orchestrator picks
 * it up on the next poll tick and dispatches headlessly.
 */
import { useEffect, useState } from 'react';
import { useModels, modelKey } from '../hooks/useModels';
import { ModelSelector } from './ModelSelector';

interface Props {
  open: boolean;
  onPick: (modelKey: string) => void;
  onClose: () => void;
}

export function OrchestratorModelPicker({ open, onPick, onClose }: Props) {
  const { models, activeModelId, setModel } = useModels();
  const [picked, setPicked] = useState<string | undefined>(activeModelId);
  useEffect(() => {
    if (open) setPicked(activeModelId);
  }, [activeModelId, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="orchestrator-picker"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 w-96 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Pick a model for this task</h3>
          <p className="text-xs text-zinc-500 mt-1">
            The task moves to <code className="text-zinc-400">in_progress</code> and the orchestrator
            dispatches it headlessly on the next poll tick.
          </p>
        </div>
        <ModelSelector
          models={models}
          currentModelId={picked}
          onSelect={(p, id) => {
            const k = modelKey(p, id);
            setPicked(k);
            void setModel(p, id);
          }}
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={() => picked && onPick(picked)}
            disabled={!picked}
            data-testid="orchestrator-picker-run"
            className="px-3 py-1.5 text-xs bg-indigo-500 text-ink rounded disabled:opacity-40"
          >
            Run task
          </button>
        </div>
      </div>
    </div>
  );
}
