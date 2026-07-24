/**
 * Input primitives for driving a page over CDP.
 *
 * Pure data and helpers — no connection, no state — so the mechanics of "which
 * accessibility roles are worth a ref" and "what does pressing Enter look like
 * on the wire" are testable without a browser.
 *
 * Part of #265 Phase 2.
 */

/**
 * Accessibility roles that are worth handing the model a ref for.
 *
 * Refs exist so the model can *act* — click, type, focus. Static content
 * (headings, paragraphs, images) is readable but not actionable, so giving it a
 * ref would only bloat the tree and invite the model to click things that do
 * nothing. This is the actionable subset.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
  'listbox',
]);

export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/** The fields `Input.dispatchKeyEvent` needs to synthesize one key. */
export interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** Present for keys that also produce a character (rare in the set we support). */
  text?: string;
}

/**
 * Named keys the `press` action accepts. Deliberately a small allowlist of the
 * keys that actually matter for driving a page — submitting, tabbing between
 * fields, dismissing, and arrow navigation — rather than a full keyboard map.
 * An unknown key is rejected by the caller so a typo doesn't silently no-op.
 */
const KEY_DEFINITIONS: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

/** The keys `press` accepts, for the tool's error message and schema docs. */
export const SUPPORTED_KEYS = Object.keys(KEY_DEFINITIONS);

/** Resolve a key name (case-insensitively for the common ones), or null. */
export function keyDefinition(key: string): KeyDefinition | null {
  const trimmed = (key ?? '').trim();
  if (KEY_DEFINITIONS[trimmed]) return KEY_DEFINITIONS[trimmed];
  // Tolerate lowercase ("enter", "tab") — a common model phrasing.
  const match = SUPPORTED_KEYS.find((k) => k.toLowerCase() === trimmed.toLowerCase());
  return match ? KEY_DEFINITIONS[match] : null;
}

/** Center point of a CDP box-model content quad `[x1,y1,…,x4,y4]`. */
export function quadCenter(quad: number[]): { x: number; y: number } | null {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}
