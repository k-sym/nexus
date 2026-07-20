import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { clearNexusMemory, maintenanceCoordinatorFor, type ClearNexusResult } from "../maintenance.js";
import { ModelError } from "../models/client.js";
import { reindexAll, type ReindexStats } from "../sync/reindex.js";

const SESSION_ARCHIVE_SYSTEM_PROMPT =
  "Summarize this Nexus session for long-term project memory. Keep only durable decisions, constraints, implementation notes, discoveries, user preferences, and follow-up context. Exclude chat filler and transient status.";

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

  app.post("/operations/summarize-session-archive", async (request, reply) => {
    const body = (request.body ?? {}) as {
      projectName?: string;
      threadTitle?: string;
      transcript?: string;
    };
    const projectName = body.projectName?.trim();
    const threadTitle = body.threadTitle?.trim();
    const transcript = body.transcript?.trim();
    if (!projectName || !threadTitle || !transcript) {
      return reply.code(400).send({ error: "projectName, threadTitle, and transcript are required" });
    }

    try {
      const summary = (await ctx.models.complete(
        `Project: ${projectName}\nSession: ${threadTitle}\n\nTranscript:\n${transcript}`,
        { system: SESSION_ARCHIVE_SYSTEM_PROMPT, temperature: 0.1, maxTokens: 700, timeoutMs: 120_000 },
      )).trim();
      if (!summary) return reply.code(502).send({ error: "Archive summary model returned empty content" });
      return { summary };
    } catch (err) {
      // Forward the model stack's own diagnosis. ModelError messages are already
      // bounded (300-char body snippet) and say things like "exceeds the available
      // context size" — actionable in a way that a bare "failed" is not.
      const detail = err instanceof ModelError ? err.message : undefined;
      return reply.code(502).send({ error: "Archive summary model failed", detail });
    }
  });
}
