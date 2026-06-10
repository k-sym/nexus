import 'fastify';
import Database from 'better-sqlite3';
import type { PiRuntime } from './pi/runtime';
import type { ConcurrencyTracker } from './pi/concurrency';
import type { ModelCurationStore } from './pi/model-curation';
import type { OAuthFlowManager } from './pi/oauth-flows';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
    pi: PiRuntime;
    chatConcurrency: ConcurrencyTracker;
    modelCuration: ModelCurationStore;
    oauthFlows: OAuthFlowManager;
  }
}

export {};
