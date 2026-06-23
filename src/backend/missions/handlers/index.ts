import type { MissionKind } from '@nexus/shared';
import type { MissionHandler } from '../types';
import { echoHandler } from './echo';
import { triageTicketsHandler } from './triage-tickets';
import { reviewStaleTasksHandler } from './review-stale-tasks';

const registry = new Map<MissionKind, MissionHandler>([
  ['echo', echoHandler],
  ['triage_tickets', triageTicketsHandler],
  ['review_stale_tasks', reviewStaleTasksHandler],
]);

export function registerHandler(kind: MissionKind, handler: MissionHandler): void {
  registry.set(kind, handler);
}

export function getHandler(kind: MissionKind): MissionHandler {
  const handler = registry.get(kind);
  if (!handler) throw new Error(`No mission handler registered for kind '${kind}'`);
  return handler;
}
