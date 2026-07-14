import type { SubView } from './components/Sidebar';

/**
 * Client-side restore of the last-open project / sub-view / chat thread so a
 * relaunch reopens where you left off instead of a blank "New Session". The
 * session data itself lives on the backend; this only remembers which selection
 * the client had, in localStorage.
 */
export const VIEW_STATE_KEY = 'nexus:view-state';

export interface PersistedView {
  activeProjectId: string | null;
  subView: SubView;
  activeThreadId: string | null;
}

export function loadViewState(): Partial<PersistedView> {
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Partial<PersistedView>) : {};
  } catch {
    return {};
  }
}

export function saveViewState(view: PersistedView): void {
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(view));
  } catch {
    /* localStorage unavailable — restore is best-effort */
  }
}
