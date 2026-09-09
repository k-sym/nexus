/**
 * OriginSessionPanel — the board's right-hand drawer that turns an Inbox item
 * (a GitHub issue or a Monday item) into a session (#439): Draft with Sonnet,
 * pick a project and a model, edit the prompt and branch, Go. The same form as
 * TicketSessionPanel, kept as its own component so #432's panel stays untouched.
 *
 * The panel owns the draft state per item; the parent owns the network call for
 * Go so it can seed the chat and navigate.
 */
import { useEffect, useState } from 'react';
import { Sparkle, Play, X, ArrowSquareOut } from '@phosphor-icons/react';
import { BOARD_BRANCH_TYPES } from '@nexus/shared';
import type { BoardBranchType, BoardInboxItem, OriginDraft, Project } from '@nexus/shared';
import { api } from '../api';
import { useModels, modelKey as makeModelKey } from '../hooks/useModels';

export interface OriginGoInput {
  projectId: string;
  problem: string;
  branchName: string;
  modelKey: string;
}

interface Props {
  /** The board's project — the default for the project select. */
  projectId: string;
  item: BoardInboxItem;
  projects: Project[];
  onGo: (item: BoardInboxItem, input: OriginGoInput) => Promise<void>;
  onClose: () => void;
}

/** Swap the `<type>/` prefix on a branch name, keeping the rest (D10). */
export function withBranchType(branchName: string, type: BoardBranchType): string {
  const rest = branchName.replace(/^(feat|fix|hotfix)\//i, '');
  return `${type}/${rest}`;
}

export default function OriginSessionPanel({ projectId, item, projects, onGo, onClose }: Props) {
  const { models, activeModelId } = useModels();
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draft, setDraft] = useState<OriginDraft | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [modelKey, setModelKey] = useState('');
  const [branchType, setBranchType] = useState<BoardBranchType>('feat');
  const [branchName, setBranchName] = useState('');
  const [problem, setProblem] = useState('');
  const [going, setGoing] = useState(false);
  const [goError, setGoError] = useState<string | null>(null);

  // Reset when the selected item changes; keep the model pick, it is a preference.
  useEffect(() => {
    setDraft(null);
    setDraftError(null);
    setGoError(null);
    setProblem('');
    setBranchType('feat');
    setBranchName('');
    setSelectedProjectId(projectId);
  }, [item.kind, item.id, projectId]);

  useEffect(() => {
    if (!modelKey && activeModelId) setModelKey(activeModelId);
  }, [activeModelId, modelKey]);

  const runDraft = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const d = await api.projects.boardDraft(projectId, { kind: item.kind, id: item.id });
      setDraft(d);
      setProblem(d.problem);
      setBranchType(d.branchType);
      setBranchName(d.branchName);
      if (d.projectId) setSelectedProjectId(d.projectId);
    } catch (err) {
      setDraftError((err as Error).message || 'Draft failed');
    } finally {
      setDrafting(false);
    }
  };

  const canGo = !going && selectedProjectId !== '' && modelKey !== '' && problem.trim() !== '' && branchName.trim() !== '';

  const go = async () => {
    if (!canGo) return;
    setGoing(true);
    setGoError(null);
    try {
      await onGo(item, { projectId: selectedProjectId, problem: problem.trim(), branchName: branchName.trim(), modelKey });
    } catch (err) {
      setGoError((err as Error).message || 'Could not start the session');
      setGoing(false);
    }
  };

  const inputClass = 'w-full surface-panel border border-subtle rounded-sm px-2 py-1 text-sm text-primary';
  const kindLabel = item.kind === 'github' ? `GitHub issue #${item.id}` : 'Monday item';
  const meta = item.kind === 'github' ? item.labels : item.status_label ? [item.status_label] : [];

  return (
    <aside
      data-testid="origin-session-panel"
      aria-label="Start a session from this item"
      className="w-80 xl:w-96 shrink-0 border-l border-subtle surface-glass flex flex-col min-h-0"
    >
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-subtle shrink-0">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-faint">{kindLabel}</div>
          <h2 className="text-sm font-semibold text-primary leading-snug break-words">{item.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {meta.map((label) => (
              <span key={label} className="text-[10px] text-muted surface-elevated px-1 py-0.5 rounded-sm">{label}</span>
            ))}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] accent-text hover:underline"
              >
                Open {item.kind === 'github' ? 'on GitHub' : 'in Monday'} <ArrowSquareOut size={11} />
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="shrink-0 text-faint hover:text-[var(--text-primary)]"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <button
          onClick={runDraft}
          disabled={drafting}
          className="w-full flex items-center justify-center gap-2 text-sm text-zinc-200 border border-zinc-800 hover:border-strong rounded-md py-2 transition-colors disabled:opacity-60"
        >
          <Sparkle size={14} weight="fill" className={drafting ? 'animate-pulse' : ''} />
          {drafting ? 'Drafting…' : draft ? 'Draft again' : 'Draft with Sonnet'}
        </button>
        {draftError && <p className="text-xs text-red-400">{draftError}</p>}

        <label className="block text-xs text-zinc-500">
          Project
          <select value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)} className={`${inputClass} mt-1`} aria-label="Project">
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <label className="block text-xs text-zinc-500">
          Model
          <select value={modelKey} onChange={(e) => setModelKey(e.target.value)} className={`${inputClass} mt-1`} aria-label="Model">
            {!modelKey && <option value="">Pick a model</option>}
            {models.map((m) => {
              const k = makeModelKey(m.provider, m.id);
              return <option key={k} value={k}>{m.name}</option>;
            })}
          </select>
        </label>

        <div className="flex gap-2">
          <label className="block text-xs text-zinc-500 w-28 shrink-0">
            Type
            <select
              value={branchType}
              onChange={(e) => {
                const t = e.target.value as BoardBranchType;
                setBranchType(t);
                if (branchName) setBranchName(withBranchType(branchName, t));
              }}
              className={`${inputClass} mt-1`}
              aria-label="Branch type"
            >
              {BOARD_BRANCH_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="block text-xs text-zinc-500 flex-1 min-w-0">
            Branch
            <input
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder={`${branchType}/short-description`}
              className={`${inputClass} mt-1 font-mono`}
              aria-label="Branch name"
            />
          </label>
        </div>

        <label className="block text-xs text-zinc-500">
          Prompt
          <textarea
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            rows={8}
            placeholder="Draft with Sonnet, or write the problem yourself."
            className={`${inputClass} mt-1 resize-y leading-relaxed`}
            aria-label="Prompt"
          />
        </label>

        <button
          onClick={go}
          disabled={!canGo}
          className="w-full flex items-center justify-center gap-2 text-sm font-medium bg-[var(--accent)] text-black rounded-md py-2 transition-opacity disabled:opacity-40"
        >
          <Play size={14} weight="fill" />
          {going ? 'Starting…' : 'Go'}
        </button>
        {goError && <p className="text-xs text-red-400">{goError}</p>}
        <p className="text-[10px] text-zinc-600 leading-snug">
          Opens a session with this prompt as the first turn. The agent works on the branch and pushes it;
          {item.kind === 'github' ? ' the issue' : ' Monday'} is never written to.
        </p>
      </div>
    </aside>
  );
}
