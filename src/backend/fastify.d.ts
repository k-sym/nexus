import 'fastify';
import Database from 'better-sqlite3';
import type { PiRuntime } from './pi/runtime';
import type { ConcurrencyTracker } from './pi/concurrency';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
    pi: PiRuntime;
    chatConcurrency: ConcurrencyTracker;
  }
}

export {};
