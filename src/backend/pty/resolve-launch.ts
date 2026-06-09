/**
 * Build the launch command for a persona's provider.
 *
 * Maps a `provider` enum to a concrete shell command. Used by the persona
 * editor to pre-fill the launch_command field for terminal-mode threads.
 *
 * Note: Slated for deletion in Phase 3 when terminal-mode threads are gone.
 * Until then, `routes/personas.ts` imports `resolveLaunchCommand` from here.
 */
import { getProviderById } from '../routes/providers';
import type Database from 'better-sqlite3';

export interface LaunchContext {
  repoPath: string;
  agentName?: string;
  systemPrompt?: string;
}

export function resolveLaunchCommand(
  db: Database.Database,
  providerId: string,
  ctx: LaunchContext,
): string {
  const provider = getProviderById(db, providerId);
  const base = provider?.name?.toLowerCase() ?? 'claude';
  return `${base} --cwd ${ctx.repoPath}`;
}
