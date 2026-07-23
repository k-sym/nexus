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

/** Every valid SubView, kept in sync with the type above so a stale/foreign
 *  value from an older or newer client build can be recognized at runtime
 *  (the type itself vanishes at compile time). */
const KNOWN_SUB_VIEWS: readonly SubView[] = ['kanban', 'memory', 'chat', 'projectManagement'];

export function loadViewState(): Partial<PersistedView> {
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result = { ...(parsed as Partial<PersistedView>) };
    // Drop an unrecognized persisted subView (e.g. left over from a client
    // version whose sub-views differ) instead of handing an invalid value to
    // React state — callers fall back to a safe default when this key is absent.
    if (result.subView !== undefined && !KNOWN_SUB_VIEWS.includes(result.subView)) {
      delete result.subView;
    }
    return result;
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
