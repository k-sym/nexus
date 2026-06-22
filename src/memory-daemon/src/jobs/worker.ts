// Background job worker. Polls the queue, runs handlers, and applies retry/backoff.
// Handlers must be idempotent (jobs are at-least-once after ghost recovery).
import type { AppContext } from "../context.js";
import { claim, complete, enqueue, fail, type Job } from "./queue.js";
import { embedPending } from "../index/indexer.js";
import { extractTriples } from "../kg/extract.js";
import { ModelError } from "../models/client.js";
import { maintenanceCoordinatorFor } from "../maintenance.js";

const IDLE_POLL_MS = 250;

async function handle(ctx: AppContext, job: Job): Promise<void> {
  const payload = JSON.parse(job.payload) as { memory_id?: string };
  switch (job.type) {
    case "deep_index": {
      const id = payload.memory_id;
      if (!id) return;
      // Backfill any chunk vectors that the inline embed missed, then embed sentences.
      await embedPending(ctx, id, "chunk");
      await embedPending(ctx, id, "sentence");
      // KG extraction is a separate job so a flaky extractor can't block/retry the embeddings.
      enqueue(ctx.db, "extract_kg", { memory_id: id });
      return;
    }
    case "extract_kg": {
      if (payload.memory_id) await extractTriples(ctx, payload.memory_id);
      return;
    }
    case "reindex_memory":
      return; // reserved
    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
}

export interface Worker {
  stop(): void;
}

export function startWorker(ctx: AppContext): Worker {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    const ranSomething = await maintenanceCoordinatorFor(ctx).runWorker(async () => {
      if (stopped) return false;
      const job = claim(ctx.db);
      if (!job) return false;
      try {
        await handle(ctx, job);
        complete(ctx.db, job.id);
      } catch (err) {
        // Misconfiguration (e.g. a reasoning-only gen model) won't fix itself on
        // retry — dead-letter it immediately with the actionable message.
        const retryable = !(err instanceof ModelError && !err.retryable);
        const outcome = fail(ctx.db, job, (err as Error).message, { retryable });
        if (outcome === "dead") console.error(`[worker] job ${job.id} (${job.type}) DEAD: ${(err as Error).message}`);
      }
      return true;
    });
    if (stopped) return;
    // Drain quickly when busy; back off to a poll interval when idle.
    timer = setTimeout(() => void tick(), ranSomething ? 0 : IDLE_POLL_MS);
  };

  void tick();
  console.log("[worker] started");
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
