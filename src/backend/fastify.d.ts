import 'fastify';
import Database from 'better-sqlite3';
import type { PiRuntime } from './pi/runtime';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
    pi: PiRuntime;
  }
}

export {};
