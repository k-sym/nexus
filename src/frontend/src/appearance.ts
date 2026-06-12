// Client-side appearance preferences. These are purely visual and live in
// localStorage so they apply instantly, with no backend round-trip, config
// file change, or restart.

const MOTION_KEY = 'nexus.backgroundMotion';
const LEGACY_BOOL_KEY = 'nexus.animateBackground';

// 'off'  — static starfield (default; zero animation cost)
// 'on'   — smooth 60fps drift/twinkle
// 'low'  — "battery saver": same motion stepped to ~5fps, ~12x cheaper
export type BackgroundMotion = 'off' | 'on' | 'low';

/** The current background-motion preference. Default 'off'. */
export function getBackgroundMotion(): BackgroundMotion {
  const v = localStorage.getItem(MOTION_KEY);
  if (v === 'on' || v === 'low' || v === 'off') return v;
  // Migrate the earlier boolean toggle, if present.
  if (localStorage.getItem(LEGACY_BOOL_KEY) === 'true') return 'on';
  return 'off';
}

/** Persist the preference and reflect it on the document immediately. */
export function setBackgroundMotion(mode: BackgroundMotion): void {
  localStorage.setItem(MOTION_KEY, mode);
  localStorage.removeItem(LEGACY_BOOL_KEY);
  applyBackgroundMotion(mode);
}

/** Toggle the ambient classes on <html> to match the preference. */
export function applyBackgroundMotion(mode: BackgroundMotion = getBackgroundMotion()): void {
  const cls = document.documentElement.classList;
  cls.toggle('ambient-animate', mode !== 'off');
  cls.toggle('ambient-lowpower', mode === 'low');
}
