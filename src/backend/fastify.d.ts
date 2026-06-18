import 'fastify';
import Database from 'better-sqlite3';
import type { PiRuntime } from './pi/runtime.js';
import type { ConcurrencyTracker } from './pi/concurrency.js';
import type { ModelCurationStore } from './pi/model-curation.js';
import type { OAuthFlowManager } from './pi/oauth-flows.js';
import type { ActivityManager } from './activity/manager.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
    pi: PiRuntime;
    chatConcurrency: ConcurrencyTracker;
    modelCuration: ModelCurationStore;
    oauthFlows: OAuthFlowManager;
    activity: ActivityManager;
    activeChatStreams?: Map<string, { session: { abort: () => Promise<void> } }>;
  }
}

export {};
