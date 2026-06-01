// SQLite index: open, load sqlite-vec, apply the (idempotent) schema.
// The DB is disposable — delete the file and call openDb() to rebuild from scratch.
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "schema.sql");

export function openDb(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  // schema.sql sets WAL + pragmas and is fully idempotent (CREATE ... IF NOT EXISTS).
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

/** Append an audit/provenance entry. */
export function oplog(
  db: DB,
  op: string,
  opts: { memory_id?: string | null; source?: string | null; detail?: string | null } = {},
): void {
  db.prepare(
    "INSERT INTO oplog (ts, op, memory_id, source, detail) VALUES (?, ?, ?, ?, ?)",
  ).run(new Date().toISOString(), op, opts.memory_id ?? null, opts.source ?? null, opts.detail ?? null);
}

/** Pack a JS number array into the little-endian float32 blob vec0 expects. */
export function toVecBlob(vec: number[] | Float32Array): Buffer {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
