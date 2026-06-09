/**
 * STUB — kept temporarily so the build stays green.
 *
 * The legacy `routes/personas.ts` (which imported `resolveLaunchCommand`)
 * was deleted in Phase 3. Nothing imports from here now; this file will be
 * removed in a follow-up commit once we're sure no test or import path
 * references it.
 */
export interface LaunchContext {
  repoPath: string;
  agentName?: string;
  systemPrompt?: string;
}

export function resolveLaunchCommand(_db: unknown, _providerId: string, _ctx: LaunchContext): string {
  return '';
}
