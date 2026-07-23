/**
 * Finding a browser to drive.
 *
 * Nexus does not ship one. A bundled Chromium is ~150MB of binary that would
 * have to be staged, signed and notarised alongside everything else in the
 * Tauri build — for a feature most sessions never touch. So we drive a browser
 * the machine already has, over CDP, and simply don't offer the tool when there
 * isn't one. Same "omit when unavailable" contract as `memory_recall`,
 * the Monday tools and `docker_service`.
 *
 * Any Chromium-family browser works: the DevTools Protocol is what we speak,
 * and Chrome, Edge, Brave and Chromium all implement it.
 *
 * Part of #265.
 */
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

export interface BrowserBinary {
  path: string;
  /** Human-readable, for logs and diagnostics. */
  name: string;
}

interface Candidate {
  path: string;
  name: string;
}

function macCandidates(): Candidate[] {
  return [
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', name: 'Google Chrome' },
    { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', name: 'Microsoft Edge' },
    { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', name: 'Chromium' },
    { path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', name: 'Brave' },
  ];
}

function linuxCandidates(): Candidate[] {
  const names: Array<[string, string]> = [
    ['google-chrome-stable', 'Google Chrome'],
    ['google-chrome', 'Google Chrome'],
    ['chromium-browser', 'Chromium'],
    ['chromium', 'Chromium'],
    ['microsoft-edge', 'Microsoft Edge'],
    ['brave-browser', 'Brave'],
  ];
  const dirs = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'];
  return names.flatMap(([bin, name]) => dirs.map((dir) => ({ path: join(dir, bin), name })));
}

function windowsCandidates(): Candidate[] {
  const roots = [
    process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
    process.env['LOCALAPPDATA'] ?? '',
  ].filter(Boolean);
  const relative: Array<[string, string]> = [
    ['Google\\Chrome\\Application\\chrome.exe', 'Google Chrome'],
    ['Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge'],
    ['Chromium\\Application\\chrome.exe', 'Chromium'],
  ];
  return roots.flatMap((root) => relative.map(([rel, name]) => ({ path: join(root, rel), name })));
}

export function browserCandidates(platform: NodeJS.Platform = process.platform): Candidate[] {
  if (platform === 'darwin') return macCandidates();
  if (platform === 'win32') return windowsCandidates();
  return linuxCandidates();
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a browser, or null when the machine has none.
 *
 * `NEXUS_BROWSER_PATH` wins outright — it's the escape hatch for a browser in
 * an unusual location, and for CI. An override that doesn't point at something
 * executable is treated as "no browser" rather than silently falling back,
 * because silently ignoring an explicit setting is how you end up debugging the
 * wrong binary.
 */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  executable: (path: string) => boolean = isExecutable,
): BrowserBinary | null {
  const override = env['NEXUS_BROWSER_PATH']?.trim();
  if (override) {
    return executable(override) ? { path: override, name: 'configured browser' } : null;
  }
  for (const candidate of browserCandidates(platform)) {
    if (executable(candidate.path)) return { path: candidate.path, name: candidate.name };
  }
  return null;
}
