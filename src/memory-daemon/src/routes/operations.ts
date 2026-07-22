import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { clearNexusMemory, maintenanceCoordinatorFor, type ClearNexusResult } from "../maintenance.js";
import { ModelError } from "../models/client.js";
import { reindexAll, type ReindexStats } from "../sync/reindex.js";

const SESSION_ARCHIVE_SYSTEM_PROMPT =
  "Summarize this Nexus session for long-term project memory. Keep only durable decisions, constraints, implementation notes, discoveries, user preferences, and follow-up context. Exclude chat filler and transient status.";

/** A full-size archive is the heaviest gen call we make: the backend caps transcripts
 *  at 30k chars (~10k tokens), and on a local 9B that measures at ~53s of prompt eval
 *  plus ~54s to generate the 700-token summary — ~107s before any queueing behind
 *  other work sharing the gen server. The old 120s budget left no margin and failed
 *  intermittently; this is sized so a queued archive still completes. */
const SESSION_ARCHIVE_TIMEOUT_MS = 300_000;

const SESSION_TITLE_SYSTEM_PROMPT =
  "You name chat sessions. Read the user's opening message and reply with a title of three to six words naming the task or topic. Reply with the title alone: no quotes, no trailing punctuation, no preamble, no explanation.";

/** Titling generates ~15 tokens off a short prompt, so it is orders of magnitude
 *  cheaper than an archive summary — but it still queues behind whatever else is
 *  using the gen server, and it runs while the user's real turn is streaming.
 *  30s is generous for the work and short enough that a wedged gen server never
 *  holds a title write open. */
const SESSION_TITLE_TIMEOUT_MS = 30_000;

/** Small local models pad titles with preamble, quotes, or a trailing period no
 *  matter how firmly the prompt forbids it. Keep the first non-empty line, strip
 *  the decoration, and cap the length so the sidebar never has to. */
export function cleanSessionTitle(raw: string): string {
  const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine
    .replace(/^(?:title|session)\s*:\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.!?,;:\s]+$/, "")
    .trim()
    .slice(0, 60);
}

const NEXT_MESSAGE_SYSTEM_PROMPT =
  "You predict the user's next message in a coding session. Read the transcript and reply with the single most likely thing the user will say next, in their voice, as a short instruction or question. Reply with that message alone: no quotes, no preamble, no explanation. Reply with nothing at all if the next move is not predictable.";

/** Generous on purpose: a late suggestion costs nothing because the frontend
 *  discards anything that lands after the user has started typing or moved on.
 *  Short enough that a wedged gen server never pins a request open. */
const NEXT_MESSAGE_TIMEOUT_MS = 20_000;

/** Same decoration problem as `cleanSessionTitle`, minus one rule: a trailing
 *  '?' is meaning in a suggestion ("what broke?"), not decoration, so unlike a
 *  title it survives. */
export function cleanSuggestion(raw: string): string {
  const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine
    .replace(/^(?:next\s+message|suggestion|user|message)\s*:\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.,;:\s]+$/, "")
    .trim()
    .slice(0, 160);
}

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
        { system: SESSION_ARCHIVE_SYSTEM_PROMPT, temperature: 0.1, maxTokens: 700, timeoutMs: SESSION_ARCHIVE_TIMEOUT_MS },
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

  app.post("/operations/generate-session-title", async (request, reply) => {
    const prompt = ((request.body ?? {}) as { prompt?: string }).prompt?.trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    try {
      const title = cleanSessionTitle(await ctx.models.complete(prompt, {
        system: SESSION_TITLE_SYSTEM_PROMPT,
        temperature: 0.2,
        maxTokens: 32,
        timeoutMs: SESSION_TITLE_TIMEOUT_MS,
      }));
      if (!title) return reply.code(502).send({ error: "Session title model returned empty content" });
      return { title };
    } catch (err) {
      const detail = err instanceof ModelError ? err.message : undefined;
      return reply.code(502).send({ error: "Session title model failed", detail });
    }
  });

  /** Predict the user's next message from the tail of a conversation, for the
   *  composer to offer as a placeholder. Note the deliberate asymmetry with
   *  session titling above: an empty result is a 200 here, not a 502, because
   *  "nothing worth suggesting" is a valid outcome rather than a failure. */
  app.post("/operations/generate-next-message", async (request, reply) => {
    const transcript = ((request.body ?? {}) as { transcript?: string }).transcript?.trim();
    if (!transcript) return reply.code(400).send({ error: "transcript is required" });

    try {
      const suggestion = cleanSuggestion(await ctx.models.complete(transcript, {
        system: NEXT_MESSAGE_SYSTEM_PROMPT,
        temperature: 0.3,
        maxTokens: 48,
        timeoutMs: NEXT_MESSAGE_TIMEOUT_MS,
      }));
      return { suggestion };
    } catch (err) {
      const detail = err instanceof ModelError ? err.message : undefined;
      return reply.code(502).send({ error: "Next message model failed", detail });
    }
  });
}
