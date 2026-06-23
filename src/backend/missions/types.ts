import type Database from 'better-sqlite3';
import type { Mission, MissionKind, MissionRunStatus } from '@nexus/shared';
import type { ActivityEvent } from '../activity/events.js';

export interface MissionRunnerDeps {
  emit?: (event: ActivityEvent) => void;
  // `pi` is the PiRuntime; only the assistant_turn handler (Task 14) uses it. Typed loosely on purpose.
  pi?: unknown;
}

export interface MissionRunContext {
  db: Database.Database;
  mission: Mission;
  runNumber: number;
  signal: AbortSignal;
  deps: MissionRunnerDeps;
}

export interface MissionRunOutcome {
  status: MissionRunStatus;
  intent?: string;
  selectedWork?: unknown;
  summary: string;
  tokensUsed?: number;
  /** backlog_drain: handler found no work; runner stops the mission with reason 'drained'. */
  drained?: boolean;
  /** self_paced: override the next interval. */
  nextDelaySeconds?: number;
  error?: string;
}

export type MissionHandler = (ctx: MissionRunContext) => Promise<MissionRunOutcome>;

export type { MissionKind };
