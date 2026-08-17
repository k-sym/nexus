/**
 * IdeasView — the Idea Watcher (#352), successor to BrainDump.
 *
 * Left: attention-grouped idea list (Waiting on you / Ripening / Parked with
 * the frictionless Enter-to-park capture box / collapsed Done). Right: the
 * selected idea's header (editable metadata + state chips) above its dialogue
 * thread — an ordinary assistant session streamed via useIdeaThread.
 *
 * Graduation to GitHub issues is the codebase's only GitHub write and is
 * confirm-gated here: api.ideas.graduateIssues is called from exactly one
 * place, the dialog's Confirm button.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ArrowSquareOut, Brain, CaretDown, CaretRight, Flask, GraduationCap, Paperclip, PaperPlaneRight, Plus, Stop, Trash, X } from '@phosphor-icons/react';
import { Idea, IdeaState, IDEA_STATES, Project, UpdateIdeaInput } from '@nexus/shared';
import { api, type CreatedIssue, type GraduateIssuesError } from '../api';
import { apiFetch } from '../api-base';
import { useIdeaThread } from '../hooks/useIdeaThread';
import type { AssistantMessage } from '../hooks/useAssistantStream';
import { AttachmentChip, usePendingAttachments } from '../lib/attachments';
import { AgentRunCard } from './AgentRunCard';
import { RunStatusStrip } from './RunStatusStrip';

interface IdeasViewProps {
  projects: Project[];
}

const STATE_LABELS: Record<IdeaState, string> = {
  parked: 'Parked',
  discussing: 'Discussing',
  researching: 'Researching',
  reviewed: 'Reviewed',
  graduated: 'Graduated',
  discarded: 'Discarded',
};

const TERMINAL_STATES: readonly IdeaState[] = ['graduated', 'discarded'];

function isTerminal(state: IdeaState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Backend copy for the idea-session attachment gate, shown client-side too. */
const REPO_GATE_MESSAGE = 'Set a valid target repo (owner/repo) on this idea before attaching files.';

/** Same shapes the backend accepts: "owner/repo" or a GitHub URL/remote. */
function isValidTargetRepo(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  if (!v) return false;
  return /^[\w.-]+\/[\w.-]+$/.test(v) || /github\.com[/:][\w.-]+\/[\w.-]+/.test(v);
}

interface PartnerModel {
  provider: string;
  id: string;
  name: string;
}

interface IssueDraftForm {
  title: string;
  body: string;
  /** Comma-separated in the UI; split on confirm. */
  labels: string;
}

function researchBriefTemplate(idea: Idea): string {
  return [
    `Research brief: ${idea.title}`,
    '',
    'What to investigate:',
    '- The core question, prior art, and realistic options (edit me).',
    '',
    ...(idea.seed.trim() ? ['Context:', idea.seed.trim(), ''] : []),
    'Preferred sources:',
    '- Official docs and primary sources first; link everything you rely on.',
    '',
    'What "done" looks like:',
    '- A findings summary with trade-offs, links, and a recommendation I can pull apart here in this thread.',
  ].join('\n');
}

function draftIssuesPrompt(repo: string): string {
  return [
    `Please draft a detailed GitHub issue set for graduating this idea${repo ? ` into ${repo}` : ''}.`,
    'For each issue give: a crisp title, a full Markdown body (context, motivation, proposed approach, acceptance criteria), and suggested labels.',
    'If the work splits naturally, propose multiple issues and note the cross-links between them.',
    'Base it on our whole discussion above, including any research findings.',
  ].join(' ');
}

export default function IdeasView({ projects }: IdeasViewProps) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [done, setDone] = useState<Idea[]>([]);
  const [doneLoaded, setDoneLoaded] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [listError, setListError] = useState<string | null>(null);

  const [researchOpen, setResearchOpen] = useState(false);
  const [graduateOpen, setGraduateOpen] = useState(false);

  // The attachment gate (#352 follow-up): attaching needs a valid target repo
  // so the backend can file uploads under project_docs/uploads/ideas/<id>/.
  const [repoNotice, setRepoNotice] = useState(false);
  const repoInputRef = useRef<HTMLInputElement | null>(null);

  const thread = useIdeaThread(sessionId);

  const selected = useMemo(
    () => ideas.find((i) => i.id === selectedId) ?? done.find((i) => i.id === selectedId) ?? null,
    [ideas, done, selectedId],
  );

  const repoValid = isValidTargetRepo(selected?.target_repo);

  const triggerRepoGate = useCallback(() => {
    setRepoNotice(true);
    repoInputRef.current?.focus();
  }, []);

  useEffect(() => { setRepoNotice(false); }, [selectedId]);
  useEffect(() => { if (repoValid) setRepoNotice(false); }, [repoValid]);

  const load = useCallback(async () => {
    try {
      const data = await api.ideas.list();
      setIdeas(data);
      setListError(null);
    } catch (err) {
      console.error('Failed to load ideas:', err);
      setListError(err instanceof Error ? err.message : 'Failed to load ideas.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadDone = useCallback(async () => {
    try {
      const all = await api.ideas.list(true);
      setDone(all.filter((i) => isTerminal(i.state)));
      setDoneLoaded(true);
    } catch (err) {
      console.error('Failed to load done ideas:', err);
    }
  }, []);

  const toggleDone = useCallback(() => {
    setDoneOpen((open) => {
      const next = !open;
      if (next && !doneLoaded) void loadDone();
      return next;
    });
  }, [doneLoaded, loadDone]);

  /** Fold an updated idea back into whichever list its state puts it in. */
  const applyUpdated = useCallback((updated: Idea) => {
    const terminal = isTerminal(updated.state);
    setIdeas((prev) => {
      const rest = prev.filter((i) => i.id !== updated.id);
      return terminal ? rest : [updated, ...rest];
    });
    setDone((prev) => {
      const rest = prev.filter((i) => i.id !== updated.id);
      return terminal ? [updated, ...rest] : rest;
    });
  }, []);

  const patchIdea = useCallback(async (id: string, data: UpdateIdeaInput): Promise<Idea | null> => {
    try {
      const updated = await api.ideas.update(id, data);
      applyUpdated(updated);
      return updated;
    } catch (err) {
      console.error('Failed to update idea:', err);
      setListError(err instanceof Error ? err.message : 'Failed to update idea.');
      return null;
    }
  }, [applyUpdated]);

  const handleQuickAdd = useCallback(async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    try {
      const idea = await api.ideas.create({ title });
      setIdeas((prev) => [idea, ...prev]);
    } catch (err) {
      console.error('Failed to park idea:', err);
      setListError(err instanceof Error ? err.message : 'Failed to park idea.');
      setDraft(title); // don't lose the capture on failure
    }
  }, [draft]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.ideas.remove(id);
      setIdeas((prev) => prev.filter((i) => i.id !== id));
      setDone((prev) => prev.filter((i) => i.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setSessionId(null);
      }
    } catch (err) {
      console.error('Failed to delete idea:', err);
    }
  }, [selectedId]);

  // Selecting an idea opens its dialogue: ensure the session exists (idempotent;
  // flips parked → discussing server-side, mirrored locally) and point the
  // thread hook at it.
  const selectIdea = useCallback(async (idea: Idea) => {
    setSelectedId(idea.id);
    setResearchOpen(false);
    setGraduateOpen(false);
    setSessionId(idea.session_id);
    try {
      const { sessionId: ensured } = await api.ideas.ensureSession(idea.id);
      setSessionId(ensured);
      if (!idea.session_id || idea.state === 'parked') {
        applyUpdated({
          ...idea,
          session_id: ensured,
          state: idea.state === 'parked' ? 'discussing' : idea.state,
        });
      }
    } catch (err) {
      console.error('Failed to open idea session:', err);
    }
  }, [applyUpdated]);

  const handleDispatchResearch = useCallback(async (brief: string, modelKey: string | undefined) => {
    if (!selected) return;
    setResearchOpen(false);
    await patchIdea(selected.id, { state: 'researching' });
    void thread.send(brief, { modelKey });
  }, [selected, patchIdea, thread]);

  const handleAskPartnerToDraft = useCallback((repo: string) => {
    setGraduateOpen(false);
    void thread.send(draftIssuesPrompt(repo));
  }, [thread]);

  const handleDiscard = useCallback(async () => {
    if (!selected) return;
    await patchIdea(selected.id, { state: 'discarded' });
  }, [selected, patchIdea]);

  // --- attention grouping ----------------------------------------------------
  const waiting = ideas.filter((i) => i.state === 'reviewed');
  const ripening = ideas.filter((i) => i.state === 'discussing' || i.state === 'researching');
  const parked = ideas.filter((i) => i.state === 'parked');

  return (
    <div className="flex-1 flex min-h-0">
      {/* Attention-grouped list */}
      <aside className="w-80 shrink-0 border-r border-subtle surface-glass flex flex-col min-h-0">
        <header className="px-4 py-3 border-b border-subtle shrink-0">
          <h1 className="text-lg font-semibold flex items-center gap-2"><Brain size={20} weight="fill" /> Ideas</h1>
          <p className="text-xs text-faint">Park it, ripen it in dialogue, graduate it.</p>
        </header>

        {listError && (
          <div className="px-4 py-2 text-xs text-red-300 border-b border-subtle" role="alert">{listError}</div>
        )}

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {waiting.length > 0 && (
            <section data-testid="section-waiting">
              <SectionHeading label="Waiting on you" count={waiting.length} />
              <div className="space-y-1.5">
                {waiting.map((idea) => (
                  <IdeaRow key={idea.id} idea={idea} selected={idea.id === selectedId} onSelect={() => void selectIdea(idea)} onDelete={() => void handleDelete(idea.id)} />
                ))}
              </div>
            </section>
          )}

          {ripening.length > 0 && (
            <section data-testid="section-ripening">
              <SectionHeading label="Ripening" count={ripening.length} />
              <div className="space-y-1.5">
                {ripening.map((idea) => (
                  <IdeaRow key={idea.id} idea={idea} selected={idea.id === selectedId} onSelect={() => void selectIdea(idea)} onDelete={() => void handleDelete(idea.id)} />
                ))}
              </div>
            </section>
          )}

          <section data-testid="section-parked">
            <SectionHeading label="Parked" count={parked.length} />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleQuickAdd(); }}
              placeholder="Park an idea and press Enter…"
              className="w-full mb-2 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong"
            />
            <div className="space-y-1.5">
              {parked.length === 0 && (
                <div className="text-xs text-zinc-600 px-1 py-2">Nothing parked. Capture a tangent above.</div>
              )}
              {parked.map((idea) => (
                <IdeaRow key={idea.id} idea={idea} selected={idea.id === selectedId} onSelect={() => void selectIdea(idea)} onDelete={() => void handleDelete(idea.id)} />
              ))}
            </div>
          </section>

          <section data-testid="section-done">
            <button
              type="button"
              onClick={toggleDone}
              className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-2 hover:text-zinc-300 transition-colors"
              aria-expanded={doneOpen}
            >
              {doneOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
              Done{doneLoaded ? ` (${done.length})` : ''}
            </button>
            {doneOpen && (
              <div className="space-y-1.5">
                {done.length === 0 && (
                  <div className="text-xs text-zinc-600 px-1 py-2">{doneLoaded ? 'Nothing graduated or discarded yet.' : 'Loading…'}</div>
                )}
                {done.map((idea) => (
                  <IdeaRow key={idea.id} idea={idea} selected={idea.id === selectedId} projects={projects} onSelect={() => void selectIdea(idea)} onDelete={() => void handleDelete(idea.id)} />
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>

      {/* Detail + dialogue */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-zinc-600 text-center max-w-sm">
              Select an idea to talk it through with the partner, commission research, or graduate it into a project or GitHub issues.
            </p>
          </div>
        ) : (
          <>
            <IdeaHeader
              key={selected.id}
              idea={selected}
              projects={projects}
              repoInputRef={repoInputRef}
              repoAttention={repoNotice}
              onPatch={(data) => patchIdea(selected.id, data)}
              onOpenResearch={() => setResearchOpen(true)}
              onOpenGraduate={() => setGraduateOpen(true)}
              onDiscard={() => void handleDiscard()}
            />
            <IdeaThreadPane
              thread={thread}
              sessionReady={!!sessionId}
              repoValid={repoValid}
              repoNotice={repoNotice}
              onRepoGate={triggerRepoGate}
            />
          </>
        )}
      </section>

      {researchOpen && selected && (
        <ResearchDialog
          idea={selected}
          onClose={() => setResearchOpen(false)}
          onDispatch={handleDispatchResearch}
        />
      )}

      {graduateOpen && selected && (
        <GraduateDialog
          idea={selected}
          projects={projects}
          onClose={() => setGraduateOpen(false)}
          onAskPartner={handleAskPartnerToDraft}
          onGraduated={applyUpdated}
          onPatch={(data) => patchIdea(selected.id, data)}
        />
      )}
    </div>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-2">
      {label} <span className="text-zinc-600">({count})</span>
    </div>
  );
}

function IdeaRow({ idea, selected, projects, onSelect, onDelete }: {
  idea: Idea;
  selected: boolean;
  projects?: Project[];
  onSelect: () => void;
  onDelete: () => void;
}) {
  const graduatedProject = idea.graduated_to?.kind === 'project'
    ? projects?.find((p) => p.id === (idea.graduated_to as { projectId: string }).projectId)
    : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      aria-label={idea.title}
      className={`group w-full text-left bg-zinc-900 border rounded-md px-3 py-2 transition-colors cursor-pointer ${
        selected ? 'border-strong' : 'border-zinc-800 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-center gap-2">
        {idea.state === 'researching' && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0"
            title="Research in flight"
            aria-label="Research in flight"
          />
        )}
        <span className="text-sm text-zinc-200 truncate flex-1">{idea.title}</span>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">{STATE_LABELS[idea.state]}</span>
        <Trash
          size={14}
          role="button"
          aria-label={`Delete ${idea.title}`}
          className="text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400 shrink-0"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        />
      </div>
      {idea.graduated_to?.kind === 'issues' && idea.graduated_to.urls.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {idea.graduated_to.urls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-cyan-300 hover:underline inline-flex items-center gap-1"
            >
              <ArrowSquareOut size={11} /> {url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
            </a>
          ))}
        </div>
      )}
      {graduatedProject && (
        <div className="mt-1 text-[11px] text-cyan-300">→ project: {graduatedProject.name}</div>
      )}
    </div>
  );
}

function IdeaHeader({ idea, projects, repoInputRef, repoAttention, onPatch, onOpenResearch, onOpenGraduate, onDiscard }: {
  idea: Idea;
  projects: Project[];
  /** Focused (and highlighted) when the attachment repo-gate trips. */
  repoInputRef: RefObject<HTMLInputElement | null>;
  repoAttention: boolean;
  onPatch: (data: UpdateIdeaInput) => Promise<Idea | null>;
  onOpenResearch: () => void;
  onOpenGraduate: () => void;
  onDiscard: () => void;
}) {
  const [title, setTitle] = useState(idea.title);
  const [tags, setTags] = useState(idea.tags.join(', '));
  const [repo, setRepo] = useState(idea.target_repo ?? '');
  const [seed, setSeed] = useState(idea.seed);

  const commitTitle = () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed === idea.title) { setTitle(idea.title); return; }
    void onPatch({ title: trimmed });
  };
  const commitTags = () => {
    const parsed = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (parsed.join(' ') === idea.tags.join(' ')) return;
    void onPatch({ tags: parsed });
  };
  const commitRepo = () => {
    const trimmed = repo.trim();
    if (trimmed === (idea.target_repo ?? '')) return;
    void onPatch({ target_repo: trimmed || null });
  };
  const commitSeed = () => {
    if (seed === idea.seed) return;
    void onPatch({ seed });
  };
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
  };

  const terminal = isTerminal(idea.state);
  const graduatedProject = idea.graduated_to?.kind === 'project'
    ? projects.find((p) => p.id === (idea.graduated_to as { projectId: string }).projectId)
    : undefined;

  return (
    <header className="surface-glass border-b border-subtle px-5 py-3 shrink-0 space-y-2.5">
      <div className="flex items-center gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={blurOnEnter}
          aria-label="Idea title"
          className="flex-1 min-w-0 bg-transparent text-lg font-semibold text-primary rounded-sm px-1 -mx-1 focus:outline-hidden focus:ring-1 focus:ring-[var(--accent)]"
        />
        <button
          type="button"
          onClick={onOpenResearch}
          className="h-8 px-3 surface-elevated border border-subtle rounded-lg flex items-center gap-1.5 text-xs text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
          title="Commission a research run into this idea's thread"
        >
          <Flask size={14} /> Research
        </button>
        <button
          type="button"
          onClick={onOpenGraduate}
          className="h-8 px-3 surface-elevated border border-subtle rounded-lg flex items-center gap-1.5 text-xs text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
          title="Graduate this idea into GitHub issues or a project"
        >
          <GraduationCap size={14} /> Graduate
        </button>
        {!terminal && (
          <button
            type="button"
            onClick={onDiscard}
            className="h-8 px-3 rounded-lg border border-red-400/35 text-red-200 bg-red-950/35 hover:border-red-300 transition-colors text-xs"
            title="Discard this idea (kept in Done, not deleted)"
          >
            Discard
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Idea state">
        {IDEA_STATES.map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={idea.state === state}
            onClick={() => { if (state !== idea.state) void onPatch({ state }); }}
            className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
              idea.state === state
                ? 'accent-button border-transparent'
                : 'border-subtle text-faint hover:text-primary hover:border-strong'
            }`}
          >
            {STATE_LABELS[state]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500/80 font-medium">Tags</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={commitTags}
            onKeyDown={blurOnEnter}
            placeholder="comma, separated"
            aria-label="Tags"
            className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500/80 font-medium">Target repo</span>
          <input
            ref={repoInputRef}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onBlur={commitRepo}
            onKeyDown={blurOnEnter}
            placeholder="owner/repo"
            aria-label="Target repo"
            className={`mt-0.5 w-full bg-zinc-950 border rounded-md px-2 py-1 text-xs text-zinc-200 placeholder:text-faint focus:outline-hidden ${
              repoAttention
                ? 'border-amber-400 ring-1 ring-amber-400/60'
                : 'border-zinc-800 focus:border-strong'
            }`}
          />
        </label>
      </div>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500/80 font-medium">Seed notes</span>
        <textarea
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          onBlur={commitSeed}
          rows={2}
          placeholder="The parked one-liner, context, links…"
          aria-label="Seed notes"
          className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1 text-xs text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong resize-none"
        />
      </label>

      {idea.graduated_to?.kind === 'issues' && idea.graduated_to.urls.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {idea.graduated_to.urls.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="text-xs text-cyan-300 hover:underline inline-flex items-center gap-1">
              <ArrowSquareOut size={12} /> {url.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
            </a>
          ))}
        </div>
      )}
      {graduatedProject && (
        <div className="text-xs text-cyan-300">Graduated into project: {graduatedProject.name}</div>
      )}
    </header>
  );
}

function IdeaThreadPane({ thread, sessionReady, repoValid, repoNotice, onRepoGate }: {
  thread: ReturnType<typeof useIdeaThread>;
  sessionReady: boolean;
  /** The idea has a usable target repo, so attaching files is allowed. */
  repoValid: boolean;
  /** The gate tripped — show the notice inline by the composer. */
  repoNotice: boolean;
  onRepoGate: () => void;
}) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const {
    pendingAttachments,
    attachmentWarning,
    addAttachmentFiles,
    removePendingAttachment,
    clearPendingAttachments,
  } = usePendingAttachments();

  useEffect(() => {
    // jsdom has no scrollIntoView; guard so tests don't need a stub.
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [thread.messages]);

  // Every attach entry point (picker button, drop, paste) funnels through the
  // repo gate: without a valid target repo the backend has nowhere stable to
  // file the upload, so we don't even open the dialog.
  const guardedAddFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (!repoValid) {
      onRepoGate();
      return;
    }
    void addAttachmentFiles(files);
  };

  const handleAttachClick = () => {
    if (!repoValid) {
      onRepoGate();
      return;
    }
    fileInputRef.current?.click();
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || thread.isRunning) return;
    // Attachments pending but the repo got cleared after picking: same notice.
    if (pendingAttachments.length > 0 && !repoValid) {
      onRepoGate();
      return;
    }
    const attachments = pendingAttachments;
    setInput('');
    const sent = await thread.send(text, {
      attachments,
      onError: (message) => {
        // The backend's own gate (e.g. repo invalidated server-side mid-turn).
        if (/target repo/i.test(message)) onRepoGate();
      },
    });
    if (sent) clearPendingAttachments();
    else setInput(text);
  };

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative"
      data-testid="idea-thread"
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault();
          setDraggingAttachments(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDraggingAttachments(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDraggingAttachments(false);
        guardedAddFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {draggingAttachments && (
        <div className="absolute inset-3 z-20 rounded-lg border border-dashed border-cyan-300/50 bg-slate-950/70 flex items-center justify-center text-sm text-primary pointer-events-none">
          Release to attach files
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {thread.loading ? (
          <p className="text-faint text-sm">Loading dialogue…</p>
        ) : thread.messages.length === 0 ? (
          <p className="text-faint text-sm">Talk the idea through with the partner — send a message to start.</p>
        ) : (
          thread.messages
            .filter((message) => message.role !== 'toolResult' && message.role !== 'tool')
            .map((message) =>
              message.role !== 'user' && message.run ? (
                <div key={message.id} className="flex justify-start">
                  <AgentRunCard
                    run={message.run}
                    content={message.content}
                    thinking={message.thinking}
                    detailsExpanded={false}
                    onOpenArtifact={() => { /* idea threads have no preview rail */ }}
                  />
                </div>
              ) : (
                <IdeaBubble key={message.id} message={message} />
              ),
            )
        )}
        <div ref={bottomRef} />
      </div>

      {thread.error && (
        <div className="px-4 py-2 border-t border-subtle text-xs text-red-300" role="alert">
          {thread.error}
        </div>
      )}

      {thread.isRunning && (
        <RunStatusStrip
          run={thread.messages.slice().reverse().find((m) => m.run)?.run ?? null}
          fallbackLabel="Working…"
        />
      )}

      <div className="border-t border-subtle surface-glass p-3">
        {repoNotice && (
          <div className="pb-2 text-xs text-amber-200" role="alert" data-testid="repo-gate-notice">
            {REPO_GATE_MESSAGE}
          </div>
        )}
        {attachmentWarning && <div className="pb-2 text-xs text-amber-200">{attachmentWarning}</div>}
        {pendingAttachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {pendingAttachments.map((attachment, index) => (
              <AttachmentChip
                key={`${attachment.name ?? attachment.type}-${index}`}
                attachment={attachment}
                index={index}
                onRemove={removePendingAttachment}
              />
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="idea-file-input"
            onChange={(e) => {
              guardedAddFiles(Array.from(e.target.files ?? []));
              e.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            onClick={handleAttachClick}
            disabled={!sessionReady}
            className="h-10 w-10 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors disabled:opacity-40"
            title="Attach files (needs a valid target repo on this idea)"
            aria-label="Attach files"
          >
            <Paperclip size={17} />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length === 0) return;
              e.preventDefault();
              guardedAddFiles(files);
            }}
            placeholder={sessionReady ? 'Discuss this idea…' : 'Opening the dialogue…'}
            rows={2}
            disabled={!sessionReady}
            data-testid="idea-chat-input"
            className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-hidden focus:border-strong disabled:opacity-50"
          />
          {thread.isRunning ? (
            <button
              type="button"
              onClick={() => void thread.abort()}
              aria-label="Stop current run"
              className="h-10 px-4 accent-button rounded-lg transition-colors flex items-center gap-2"
            >
              <Stop size={17} weight="fill" /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!sessionReady || (!input.trim() && pendingAttachments.length === 0)}
              data-testid="idea-send-button"
              className="h-10 px-4 accent-button rounded-lg disabled:opacity-40 transition-colors flex items-center gap-2"
            >
              <PaperPlaneRight size={17} weight="fill" /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function IdeaBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-chat-role={isUser ? 'user' : 'assistant'}
        className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm ${
          isUser ? 'chat-request-bubble' : 'surface-glass border border-subtle text-primary'
        }`}
      >
        {isUser && message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 grid grid-cols-2 gap-2">
            {message.attachments.map((attachment, index) => (
              attachment.type === 'image' ? (
                <img
                  key={`${attachment.name ?? 'image'}-${index}`}
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                  alt={attachment.name ?? `Attached image ${index + 1}`}
                  className="max-h-40 rounded-lg border border-subtle object-cover"
                />
              ) : (
                <div
                  key={`${attachment.name}-${index}`}
                  className="min-w-0 rounded-md border border-subtle bg-zinc-950/35 px-2 py-1.5 text-xs text-primary"
                >
                  <span className="break-all">{attachment.name}</span>
                </div>
              )
            ))}
          </div>
        )}
        <p className="whitespace-pre-wrap">{message.content || (message.isStreaming ? 'Running...' : '')}</p>
      </div>
    </div>
  );
}

function ResearchDialog({ idea, onClose, onDispatch }: {
  idea: Idea;
  onClose: () => void;
  onDispatch: (brief: string, modelKey: string | undefined) => Promise<void> | void;
}) {
  const [brief, setBrief] = useState(() => researchBriefTemplate(idea));
  const [models, setModels] = useState<PartnerModel[]>([]);
  const [modelKey, setModelKey] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/assistant/models');
        if (!res.ok) return;
        const data = (await res.json()) as { models?: PartnerModel[]; default?: string };
        if (cancelled) return;
        setModels(data.models ?? []);
        if (data.default) setModelKey(data.default);
      } catch {
        /* fail-soft: picker only offers Default */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <Dialog title="Commission research" onClose={onClose}>
      <p className="text-xs text-faint">
        The brief is sent as a turn in this idea's thread; findings come back here for you to pull apart.
      </p>
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={12}
        aria-label="Research brief"
        className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary focus:outline-hidden focus:border-strong resize-y"
      />
      <div className="flex items-center gap-2">
        <label className="text-xs text-faint" htmlFor="research-model">Model</label>
        <select
          id="research-model"
          value={modelKey}
          onChange={(e) => setModelKey(e.target.value)}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-sm text-zinc-200 focus:outline-hidden focus:border-strong"
        >
          <option value="">Default</option>
          {models.map((m) => (
            <option key={m.id} value={`${m.provider}/${m.id}`}>{m.name}</option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="h-9 px-3 surface-elevated border border-subtle rounded-lg text-sm text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onDispatch(brief, modelKey || undefined)}
          disabled={!brief.trim()}
          className="h-9 px-4 accent-button rounded-lg text-sm disabled:opacity-40 transition-colors"
        >
          Dispatch research
        </button>
      </div>
    </Dialog>
  );
}

function GraduateDialog({ idea, projects, onClose, onAskPartner, onGraduated, onPatch }: {
  idea: Idea;
  projects: Project[];
  onClose: () => void;
  onAskPartner: (repo: string) => void;
  onGraduated: (idea: Idea) => void;
  onPatch: (data: UpdateIdeaInput) => Promise<Idea | null>;
}) {
  const [tab, setTab] = useState<'issues' | 'project'>('issues');
  const [repo, setRepo] = useState(idea.target_repo ?? '');
  const [drafts, setDrafts] = useState<IssueDraftForm[]>([{ title: idea.title, body: '', labels: '' }]);
  const [projectId, setProjectId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedIssue[] | null>(null);
  const [movedFiles, setMovedFiles] = useState<number | null>(null);

  const validDrafts = drafts.every((d) => d.title.trim() && d.body.trim());
  const canFile = !busy && repo.trim().length > 0 && drafts.length > 0 && validDrafts;

  const updateDraft = (index: number, patch: Partial<IssueDraftForm>) => {
    setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const handleConfirmIssues = async () => {
    if (!canFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.ideas.graduateIssues(idea.id, {
        repo: repo.trim(),
        issues: drafts.map((d) => ({
          title: d.title.trim(),
          body: d.body,
          ...(d.labels.trim() ? { labels: d.labels.split(',').map((l) => l.trim()).filter(Boolean) } : {}),
        })),
      });
      setCreated(result.issues);
      onGraduated(result.idea);
    } catch (err) {
      const gErr = err as GraduateIssuesError;
      setError(gErr.message || 'Failed to file issues.');
      if (gErr.issues && gErr.issues.length > 0) setCreated(gErr.issues);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmProject = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!projectId) {
        // "No project": plain state change, nothing to move.
        await onPatch({ state: 'graduated' });
        onClose();
        return;
      }
      // Records graduation AND moves the idea's uploads into the project repo.
      // A 400 (repo path unusable with files to move) leaves the idea
      // un-graduated — surface the message verbatim and stay open.
      const result = await api.ideas.graduateProject(idea.id, projectId);
      onGraduated(result.idea);
      if (result.movedFiles > 0) {
        setMovedFiles(result.movedFiles);
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to graduate idea.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Graduate idea" onClose={onClose} wide>
      <div className="flex gap-1.5" role="tablist" aria-label="Graduation path">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'issues'}
          onClick={() => setTab('issues')}
          className={`px-3 py-1 rounded-md text-sm transition-colors ${tab === 'issues' ? 'surface-active accent-text' : 'text-muted hover:text-[var(--text-primary)]'}`}
        >
          GitHub issues
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'project'}
          onClick={() => setTab('project')}
          className={`px-3 py-1 rounded-md text-sm transition-colors ${tab === 'project' ? 'surface-active accent-text' : 'text-muted hover:text-[var(--text-primary)]'}`}
        >
          Project
        </button>
      </div>

      {tab === 'issues' ? (
        <>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500/80 font-medium">Repository</span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
              aria-label="Repository"
              className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-sm text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong"
            />
          </label>

          <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
            {drafts.map((draftItem, index) => (
              <div key={index} className="border border-subtle rounded-lg p-3 space-y-2 surface-panel">
                <div className="flex items-center gap-2">
                  <input
                    value={draftItem.title}
                    onChange={(e) => updateDraft(index, { title: e.target.value })}
                    placeholder="Issue title"
                    aria-label={`Issue ${index + 1} title`}
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-sm text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong"
                  />
                  {drafts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}
                      aria-label={`Remove issue ${index + 1}`}
                      className="h-7 w-7 rounded-md border border-subtle text-muted hover:text-red-300 hover:border-strong transition-colors flex items-center justify-center"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <textarea
                  value={draftItem.body}
                  onChange={(e) => updateDraft(index, { body: e.target.value })}
                  placeholder="Full issue body (Markdown) — context, motivation, approach, acceptance criteria…"
                  aria-label={`Issue ${index + 1} body`}
                  rows={5}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-sm text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong resize-y"
                />
                <input
                  value={draftItem.labels}
                  onChange={(e) => updateDraft(index, { labels: e.target.value })}
                  placeholder="labels, comma, separated (optional)"
                  aria-label={`Issue ${index + 1} labels`}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-xs text-zinc-200 placeholder:text-faint focus:outline-hidden focus:border-strong"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDrafts((current) => [...current, { title: '', body: '', labels: '' }])}
              className="h-8 px-3 surface-elevated border border-subtle rounded-lg flex items-center gap-1.5 text-xs text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
            >
              <Plus size={13} /> Add issue
            </button>
            <button
              type="button"
              onClick={() => onAskPartner(repo.trim())}
              className="h-8 px-3 surface-elevated border border-subtle rounded-lg text-xs text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
              title="Send a canned turn asking the partner to draft the issue set in the thread; copy/edit the draft into this form"
            >
              Ask partner to draft
            </button>
          </div>

          {error && <div className="text-xs text-red-300" role="alert">{error}</div>}

          {created && created.length > 0 && (
            <div className="space-y-1" data-testid="created-issues">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500/80 font-medium">Filed</div>
              {created.map((issue) => (
                <a key={issue.html_url} href={issue.html_url} target="_blank" rel="noreferrer" className="block text-xs text-cyan-300 hover:underline">
                  #{issue.number} — {issue.html_url}
                </a>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 px-3 surface-elevated border border-subtle rounded-lg text-sm text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors">
              {created && created.length > 0 ? 'Done' : 'Cancel'}
            </button>
            {!created && (
              <button
                type="button"
                onClick={() => void handleConfirmIssues()}
                disabled={!canFile}
                data-testid="confirm-file-issues"
                className="h-9 px-4 accent-button rounded-lg text-sm disabled:opacity-40 transition-colors"
              >
                {busy ? 'Filing…' : `Confirm — file ${drafts.length} issue${drafts.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500/80 font-medium">Graduate into project</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={movedFiles !== null}
              aria-label="Graduate into project"
              className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-1.5 text-sm text-zinc-200 focus:outline-hidden focus:border-strong disabled:opacity-50"
            >
              <option value="">No project (just mark graduated)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-faint">
            Graduating into a project also moves this idea's uploaded files into the project repo.
          </p>

          {error && <div className="text-xs text-red-300" role="alert">{error}</div>}

          {movedFiles !== null && (
            <div className="text-xs text-emerald-300" data-testid="graduate-project-result">
              Graduated. {movedFiles} file{movedFiles === 1 ? '' : 's'} moved into the project.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 px-3 surface-elevated border border-subtle rounded-lg text-sm text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors">
              {movedFiles !== null ? 'Done' : 'Cancel'}
            </button>
            {movedFiles === null && (
              <button
                type="button"
                onClick={() => void handleConfirmProject()}
                disabled={busy}
                data-testid="confirm-graduate-project"
                className="h-9 px-4 accent-button rounded-lg text-sm disabled:opacity-40 transition-colors"
              >
                {busy ? 'Graduating…' : 'Graduate'}
              </button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

function Dialog({ title, wide, onClose, children }: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-zinc-950/60 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`surface-elevated border border-subtle rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[85vh] overflow-y-auto p-5 space-y-3`}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title.toLowerCase()} dialog`}
            className="h-7 w-7 rounded-md border border-subtle text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors flex items-center justify-center"
          >
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
