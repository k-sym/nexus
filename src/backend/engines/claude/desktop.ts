/**
 * The Claude Desktop app as seen from this host: whether it is installed,
 * whether it keeps a session index here, the deep link that makes it adopt a
 * Claude Code session, and the list of its sessions for a repo path.
 *
 * Everything reads `~/.claude/projects` through the SDK; the only write to
 * the desktop app is `open claude://resume?session=<id>`, which is the import
 * hook the app exposes (its own resume picker hides SDK-created sessions —
 * `listSessions({ includeProgrammatic: false })` — so the link is the path).
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { listSessions as sdkListSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { DesktopSessionSummary } from '@nexus/shared';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, findClaudeModel } from './models.js';

const execFile = promisify(nodeExecFile);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DesktopStatus {
  /** `/Applications/Claude.app` (or the user's Applications folder) exists. */
  appFound: boolean;
  /** The desktop app has written its Claude Code session index on this host. */
  indexFound: boolean;
}

export const DESKTOP_APP_PATHS = ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')];
export const DESKTOP_SESSION_INDEX = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

export function desktopStatus(options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {}): DesktopStatus {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  if (platform !== 'darwin') return { appFound: false, indexFound: false };
  return {
    appFound: DESKTOP_APP_PATHS.some((path) => exists(path)),
    indexFound: exists(DESKTOP_SESSION_INDEX),
  };
}

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The deep link the desktop app handles by importing (adopting) the session. */
export function desktopResumeUrl(sessionId: string): string {
  if (!isClaudeSessionId(sessionId)) throw new Error(`Not a Claude Code session id: ${sessionId}`);
  return `claude://resume?session=${sessionId}`;
}

export type OpenUrlFn = (url: string) => Promise<void>;

const openWithLaunchServices: OpenUrlFn = async (url) => {
  await execFile('/usr/bin/open', [url]);
};

/** Ask the desktop app to adopt the session. Resolves once `open` returns; the app does the rest asynchronously. */
export async function openInDesktop(sessionId: string, openUrl: OpenUrlFn = openWithLaunchServices): Promise<string> {
  const url = desktopResumeUrl(sessionId);
  await openUrl(url);
  return url;
}

export type ListSessionsFn = (options: { dir: string; includeProgrammatic: boolean }) => Promise<SDKSessionInfo[]>;

function summarize(info: SDKSessionInfo): DesktopSessionSummary {
  return {
    id: info.sessionId,
    title: (info.customTitle || info.summary || info.firstPrompt || '').trim() || 'Untitled session',
    first_prompt: info.firstPrompt?.trim() || null,
    last_modified: new Date(info.lastModified).toISOString(),
    created_at: info.createdAt ? new Date(info.createdAt).toISOString() : null,
    git_branch: info.gitBranch || null,
    cwd: info.cwd || null,
  };
}

/**
 * Sessions under the repo path that a person ran — the desktop app's and the
 * terminal's — minus those already behind a Nexus thread. Nexus's own
 * threads are SDK sessions and are left out by `includeProgrammatic: false`.
 */
export async function listImportableSessions(repoPath: string, exclude: Iterable<string>, listSessions: ListSessionsFn = (options) => sdkListSessions(options)): Promise<DesktopSessionSummary[]> {
  const excluded = new Set(exclude);
  const infos = await listSessions({ dir: repoPath, includeProgrammatic: false });
  return infos
    .filter((info) => !excluded.has(info.sessionId))
    .map(summarize)
    .sort((a, b) => (a.last_modified < b.last_modified ? 1 : a.last_modified > b.last_modified ? -1 : 0));
}

/** `claude-code/<id>` for the model a replayed transcript last answered with, falling back to the catalog's first entry. */
export function modelKeyFor(lastModel: string | undefined): string {
  const id = lastModel && findClaudeModel(lastModel) ? lastModel : CLAUDE_CODE_MODELS[0].id;
  return `${CLAUDE_CODE_PROVIDER}/${id}`;
}
