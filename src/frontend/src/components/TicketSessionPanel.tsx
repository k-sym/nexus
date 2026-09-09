/**
 * TicketSessionPanel — the part of the Tickets sidebar that turns a ticket into
 * a session (#432): Draft with Sonnet, pick a project and a model, edit the
 * prompt and branch, Go. The session replaces the old "create a Kanban task".
 *
 * The panel owns the draft state per ticket; the parent owns the network call
 * for Go so it can seed the chat and navigate.
 */
import { useEffect, useState } from 'react';
import { Sparkle, Play } from '@phosphor-icons/react';
import { Project, Ticket, TicketDraft, TICKET_BRANCH_TYPES, TicketBranchType } from '@nexus/shared';
import { api } from '../api';
import { useModels, modelKey as makeModelKey } from '../hooks/useModels';
import SelectMenu from './SelectMenu';

export interface TicketGoInput {
  projectId: string;
  problem: string;
  branchName: string;
  modelKey: string;
}

interface Props {
  ticket: Ticket;
  projects: Project[];
  onGo: (ticket: Ticket, input: TicketGoInput) => Promise<void>;
  onOpenSession: (projectId: string, threadId: string) => void;
}

/** Swap the `<type>/` prefix on a branch name, keeping the rest. */
function withBranchType(branchName: string, type: TicketBranchType): string {
  const rest = branchName.replace(/^(fix|hotfix|feature)\//i, '');
  return `${type}/${rest}`;
}

export default function TicketSessionPanel({ ticket, projects, onGo, onOpenSession }: Props) {
  const { models, activeModelId } = useModels();
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [projectId, setProjectId] = useState('');
  // True once the user has picked a project by hand for this ticket. A draft
  // then only *suggests* its project instead of replacing the pick: SUP-1359
  // was opened in the wrong project after Sonnet's pick silently overrode one.
  const [projectPicked, setProjectPicked] = useState(false);
  const [suggestedProjectId, setSuggestedProjectId] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState('');
  const [branchType, setBranchType] = useState<TicketBranchType>('fix');
  const [branchName, setBranchName] = useState('');
  const [problem, setProblem] = useState('');
  const [going, setGoing] = useState(false);
  const [goError, setGoError] = useState<string | null>(null);

  // Reset when the selected ticket changes; keep the model pick, it is a preference.
  useEffect(() => {
    setDraft(null);
    setDraftError(null);
    setGoError(null);
    setProblem('');
    setBranchType('fix');
    setBranchName('');
    setProjectPicked(false);
    setSuggestedProjectId(null);
    setProjectId((prev) => prev || projects[0]?.id || '');
  }, [ticket.key, projects]);

  useEffect(() => {
    if (!modelKey && activeModelId) setModelKey(activeModelId);
  }, [activeModelId, modelKey]);

  const runDraft = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const d = await api.tickets.draft(ticket.key);
      setDraft(d);
      setProblem(d.problem);
      setBranchType(d.branchType);
      setBranchName(d.branchName);
      setSuggestedProjectId(d.projectId);
      if (d.projectId && !projectPicked) setProjectId(d.projectId);
    } catch (err) {
      setDraftError((err as Error).message || 'Draft failed');
    } finally {
      setDrafting(false);
    }
  };

  const pickProject = (id: string) => {
    setProjectId(id);
    setProjectPicked(true);
  };
  const suggestedProject = suggestedProjectId && suggestedProjectId !== projectId
    ? projects.find((p) => p.id === suggestedProjectId) ?? null
    : null;

  const canGo = !going && projectId !== '' && modelKey !== '' && problem.trim() !== '' && branchName.trim() !== '';

  const go = async () => {
    if (!canGo) return;
    setGoing(true);
    setGoError(null);
    try {
      await onGo(ticket, { projectId, problem: problem.trim(), branchName: branchName.trim(), modelKey });
    } catch (err) {
      setGoError((err as Error).message || 'Could not start the session');
      setGoing(false);
    }
  };

  const inputClass = 'w-full surface-panel border border-subtle rounded-sm px-2 py-1 text-sm text-primary';

  if (ticket.session) {
    return (
      <div className="space-y-2" data-testid="ticket-session-open">
        <p className="text-xs text-zinc-500">This ticket already has a session.</p>
        <button
          onClick={() => onOpenSession(ticket.session!.project_id, ticket.session!.thread_id)}
          className="w-full text-center text-sm accent-text border border-zinc-800 hover:border-strong rounded-md py-2 transition-colors"
        >
          Open session
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="ticket-session-panel">
      <button
        onClick={runDraft}
        disabled={drafting}
        className="w-full flex items-center justify-center gap-2 text-sm text-zinc-200 border border-zinc-800 hover:border-strong rounded-md py-2 transition-colors disabled:opacity-60"
      >
        <Sparkle size={14} weight="fill" className={drafting ? 'animate-pulse' : ''} />
        {drafting ? 'Drafting…' : draft ? 'Draft again' : 'Draft with Sonnet'}
      </button>
      {draftError && <p className="text-xs text-red-400">{draftError}</p>}

      <div className="text-xs text-zinc-500">
        Project
        <SelectMenu
          label="Project"
          className="mt-1"
          value={projectId}
          placeholder={projects.length === 0 ? 'No projects' : 'Pick a project'}
          options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.repo_path }))}
          onChange={pickProject}
        />
        {suggestedProject && (
          <p className="mt-1 text-[10px] text-faint">
            Sonnet suggested {suggestedProject.name}.{' '}
            <button type="button" onClick={() => pickProject(suggestedProject.id)} className="accent-text hover:underline">
              Use it
            </button>
          </p>
        )}
      </div>

      <div className="text-xs text-zinc-500">
        Model
        <SelectMenu
          label="Model"
          className="mt-1"
          value={modelKey}
          placeholder="Pick a model"
          options={models.map((m) => ({ value: makeModelKey(m.provider, m.id), label: m.name, hint: `${m.provider} · ${m.id}` }))}
          onChange={setModelKey}
        />
      </div>

      <div className="flex gap-2">
        <div className="text-xs text-zinc-500 w-28 shrink-0">
          Type
          <SelectMenu
            label="Branch type"
            className="mt-1"
            value={branchType}
            options={TICKET_BRANCH_TYPES.map((t) => ({ value: t, label: t }))}
            onChange={(v) => {
              const t = v as TicketBranchType;
              setBranchType(t);
              if (branchName) setBranchName(withBranchType(branchName, t));
            }}
          />
        </div>
        <label className="block text-xs text-zinc-500 flex-1 min-w-0">
          Branch
          <input
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder={`${branchType}/${ticket.key.replace(/-/g, '')}-short-description`}
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
          rows={6}
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
        Opens a session in the project with this prompt as the first turn. The agent works on the branch and pushes it; Jira is never touched.
      </p>
    </div>
  );
}
