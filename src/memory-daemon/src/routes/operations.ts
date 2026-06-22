import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { clearNexusMemory, maintenanceCoordinatorFor, type ClearNexusResult } from "../maintenance.js";
import { reindexAll, type ReindexStats } from "../sync/reindex.js";

export interface OperationDependencies {
  rebuild: () => Promise<ReindexStats>;
  clearNexus: () => ClearNexusResult;
  reconcile: () => Promise<ReindexStats>;
}

export function registerOperationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  dependencies: OperationDependencies = {
    rebuild: () => reindexAll(ctx, { force: true }),
    clearNexus: () => clearNexusMemory(ctx),
    reconcile: () => reindexAll(ctx),
  },
): void {
  const coordinator = maintenanceCoordinatorFor(ctx);

  const runExclusive = async <T>(
    name: "rebuild" | "clear",
    work: () => Promise<T> | T,
    reply: FastifyReply,
  ): Promise<T | FastifyReply> => {
    const result = await coordinator.runMaintenance(name, work);
    if (!result.acquired) {
      return reply.code(409).send({ error: `Memory maintenance already running: ${result.running}` });
    }
    return result.value;
  };

  app.post("/operations/rebuild-index", (_request, reply) =>
    runExclusive("rebuild", dependencies.rebuild, reply));

  app.post("/operations/clear-nexus", (request, reply) => {
    if ((request.body as { confirmation?: string } | null)?.confirmation !== "CLEAR NEXUS MEMORY") {
      return reply.code(400).send({ error: "Exact confirmation phrase required" });
    }
    return runExclusive("clear", async () => {
      const result = dependencies.clearNexus();
      try {
        const reconciliation = await dependencies.reconcile();
        return { ...result, reconciliation, ok: result.failed === 0 };
      } catch {
        return {
          ...result,
          reconciliation: null,
          reconciliationError: "Index reconciliation failed",
          ok: false,
        };
      }
    }, reply);
  });
}
