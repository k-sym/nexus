// Shared runtime context passed across server, sync engine, and (later) the job worker.
import type { DB } from "./db/index.js";
import type { DaemonConfig } from "./config.js";
import type { ModelClient } from "./models/client.js";

export interface AppContext {
  cfg: DaemonConfig;
  db: DB;
  models: ModelClient;
  /**
   * Absolute file paths the daemon is currently writing. The watcher skips events
   * for these to avoid reacting to its own writes (belt-and-braces alongside the
   * last_written_hash echo check).
   */
  inflight: Set<string>;
}
