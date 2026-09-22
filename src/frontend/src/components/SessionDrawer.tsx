import { useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import RightRail, { type RailTab } from './RightRail';
import { MemoryComposer, MemoryList } from './MemoryTab';
import ArtifactPreviewTab from './ArtifactPreviewTab';
import SubAgentsTab from './SubAgentsTab';

export type DrawerTab = 'memory' | 'preview' | 'subagents';
export interface DrawerState { open: boolean; tab: DrawerTab }

const STORAGE_KEY = 'nexus.sessionDrawer';
/** The memory rail's key from before the tabs, honoured until the drawer has saved its own state. */
const LEGACY_MEMORY_KEY = 'nexus.memoryRail.open';
const TABS: Array<RailTab & { id: DrawerTab }> = [
  { id: 'memory', label: 'Memory' },
  { id: 'preview', label: 'Preview' },
  { id: 'subagents', label: 'Sub-agents' },
];
const isTab = (value: unknown): value is DrawerTab => TABS.some((tab) => tab.id === value);

export function loadDrawerState(): DrawerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DrawerState>;
      if (typeof parsed.open === 'boolean' && isTab(parsed.tab)) return { open: parsed.open, tab: parsed.tab };
    }
    return { open: localStorage.getItem(LEGACY_MEMORY_KEY) !== 'false', tab: 'memory' };
  } catch {
    return { open: true, tab: 'memory' };
  }
}

export function saveDrawerState(state: DrawerState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

interface SessionDrawerProps {
  projectId: string;
  threadId: string | null;
  /** Whether the session's own run is live; the Sub-agents tab polls faster while it is. */
  running: boolean;
  /** The file the Preview tab shows, set when a path in chat is clicked. */
  artifactPath: string | null;
  state: DrawerState;
  onStateChange: (state: DrawerState) => void;
  /** Navigate to the project's full Memory page. */
  onOpenMemoryPage: () => void;
}

/** The right-hand drawer of a project session: Memory, Preview and Sub-agents
 *  as tabs of one collapsible, resizable rail. Only the showing tab mounts, so
 *  only it polls. */
export default function SessionDrawer({ projectId, threadId, running, artifactPath, state, onStateChange, onOpenMemoryPage }: SessionDrawerProps) {
  const [memoryVersion, setMemoryVersion] = useState(0);
  const active = TABS.find((tab) => tab.id === state.tab) ?? TABS[0];

  return (
    <RightRail
      label={active.label}
      title={active.label}
      ariaLabel="Session drawer"
      open={state.open}
      onOpenChange={(open) => onStateChange({ ...state, open })}
      tabs={TABS}
      activeTab={active.id}
      onTabChange={(tab) => { if (isTab(tab)) onStateChange({ ...state, tab }); }}
      resizable
      initialWidth={320}
      actions={active.id === 'memory' ? (
        <button
          type="button"
          onClick={onOpenMemoryPage}
          title="Open full Memory page"
          className="flex items-center gap-1 text-xs text-faint hover:text-[var(--text-primary)] transition-colors"
        >
          <ArrowSquareOut size={14} /> Open
        </button>
      ) : null}
      footer={active.id === 'memory' ? (
        <MemoryComposer projectId={projectId} onAdded={() => setMemoryVersion((current) => current + 1)} />
      ) : undefined}
    >
      <section role="tabpanel" aria-label={active.label} className="h-full min-h-0">
        {active.id === 'memory' && <MemoryList projectId={projectId} version={memoryVersion} />}
        {active.id === 'preview' && <ArtifactPreviewTab projectId={projectId} selectedPath={artifactPath} />}
        {active.id === 'subagents' && <SubAgentsTab threadId={threadId} running={running} />}
      </section>
    </RightRail>
  );
}
