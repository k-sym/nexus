// Fastify HTTP surface: /health + memory routes (store/recall/CRUD).
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { registerMemoryRoutes } from "./routes/memory.js";

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  registerMemoryRoutes(app, ctx);

  app.get("/health", async () => {
    const models = await ctx.models.health();
    const counts = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL")
      .get() as { n: number };
    const pendingJobs = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'PENDING'")
      .get() as { n: number };
    const deadJobs = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'DEAD'")
      .get() as { n: number };

    const ok = models.embed; // embeddings are the minimum viable retrieval primitive
    return {
      status: ok ? "ok" : "degraded",
      vault: ctx.cfg.vaultPath,
      db: ctx.cfg.dbPath,
      memories: counts.n,
      jobs: { pending: pendingJobs.n, dead: deadJobs.n },
      models,
    };
  });

  return app;
}
