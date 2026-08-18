// Daemon configuration. Reads ~/.nexus/config.yaml if present (shared with Nexus),
// applies env interpolation (${VAR}), and falls back to the verified local stack defaults.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
// Namespace import, not default: js-yaml 5 is ESM-only with named exports and no
// default, so `import yaml from "js-yaml"` throws at load time. This package's lock
// already resolves 5.2.1; only a stale node_modules was hiding it.
import * as yaml from "js-yaml";

/** Gen tasks with per-task cloud model selection. */
export type GenTask = "kg_extraction" | "archive_summary" | "session_title" | "next_message" | "hyde";

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  /** Per-task chat model; tasks absent here use `defaultModel`. */
  tasks: Partial<Record<GenTask, string>>;
  defaultModel: string;
  /** Rerank model on OpenRouter's /rerank endpoint (Cohere-style wire shape). */
  rerankModel: string;
}

export interface DaemonConfig {
  /** HTTP/MCP bind port for the daemon. */
  port: number;
  host: string;
  /** Canonical Obsidian vault root (markdown is the source of truth). */
  vaultPath: string;
  /** Where the disposable SQLite index lives (inside the vault by default). */
  dbPath: string;
  models: {
    /** 9B gen — HyDE + KG extraction. Fallback tier when OpenRouter is configured. */
    genUrl: string;
    /** nomic-embed 768-dim. Always local: the sqlite-vec index is built in this
     *  model's 768-dim space, and at 10-30ms/call the local server beats any
     *  network round-trip — embeddings are the deliberate exception to cloud-first. */
    embedUrl: string;
    embedModel: string;
    /** Qwen3 reranker. Fallback tier when OpenRouter is configured. */
    rerankUrl: string;
    rerankModel: string;
    apiKey?: string;
    /** Cloud-first gen + rerank via OpenRouter; absent => local-only (original behavior). */
    openrouter?: OpenRouterConfig;
    /** "cloud" tries OpenRouter first (when configured); "local" is the kill switch
     *  back to local-only without deleting the openrouter config. */
    prefer: "cloud" | "local";
  };
  retrieval: {
    hyde: boolean;
    sentenceThreshold: number;
    sentenceK: number;
    chunkK: number;
    rerankK: number;
    /** Deadline for the cross-encoder call inside recall; on expiry recall degrades to
     *  fusion order instead of holding the response (interactive callers budget ~2.5s). */
    rerankTimeoutMs: number;
    tokenBudget: number;
  };
}

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return resolve(p);
}

/** Deep-read a dotted path from a parsed-yaml object. */
function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object" && k in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

const GEN_TASKS: GenTask[] = ["kg_extraction", "archive_summary", "session_title", "next_message", "hyde"];
/** All gen tasks default to Haiku — Keith wants text-producing tasks consistent
 *  with the Anthropic models doing the rest of his work, and at these volumes the
 *  premium over a flash-class model is a few $/month. */
const DEFAULT_GEN_MODEL = "anthropic/claude-haiku-4.5";
/** Purpose-built cross-encoder on OpenRouter's /rerank endpoint (~$0.02/M tokens,
 *  ~400ms for a 25-doc recall batch — measured live 2026-08-18). */
const DEFAULT_RERANK_MODEL = "voyageai/rerank-2.5-lite";

/** OpenRouter config is present only when an api_key survives env interpolation —
 *  an unset ${OPENROUTER_API_KEY} interpolates to "" and disables the cloud tier
 *  cleanly rather than producing doomed authorization headers. */
function loadOpenRouter(raw: unknown, str: (v: unknown, fallback: string) => string): OpenRouterConfig | undefined {
  const apiKey = str(pick(raw, "memory.models.openrouter.api_key"), "");
  if (!apiKey) return undefined;
  const defaultModel = str(pick(raw, "memory.models.openrouter.default_model"), DEFAULT_GEN_MODEL);
  const tasks: Partial<Record<GenTask, string>> = {};
  for (const task of GEN_TASKS) {
    tasks[task] = str(pick(raw, `memory.models.openrouter.tasks.${task}`), defaultModel);
  }
  return {
    apiKey,
    baseUrl: str(pick(raw, "memory.models.openrouter.base_url"), "https://openrouter.ai/api/v1"),
    tasks,
    defaultModel,
    rerankModel: str(pick(raw, "memory.models.openrouter.rerank_model"), DEFAULT_RERANK_MODEL),
  };
}

export function loadConfig(): DaemonConfig {
  const nexusHome = process.env.NEXUS_HOME ? expandHome(process.env.NEXUS_HOME) : join(homedir(), ".nexus");
  const configFile = join(nexusHome, "config.yaml");

  let raw: unknown = {};
  if (existsSync(configFile)) {
    try {
      raw = yaml.load(readFileSync(configFile, "utf8")) ?? {};
    } catch (err) {
      console.warn(`[config] failed to parse ${configFile}: ${(err as Error).message} — using defaults`);
    }
  }

  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? interpolateEnv(v) : fallback;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

  // Default to a visible location (~/Obsidian/Nexus) so the vault is selectable
  // in Obsidian's "Open folder as vault" picker; ~/.nexus is hidden. Existing
  // installs override this via vault_path in config.yaml.
  const vaultPath = expandHome(
    str(pick(raw, "memory.vault_path") ?? pick(raw, "obsidian.vault_path"), join(homedir(), "Obsidian", "Nexus")),
  );

  return {
    port: num(pick(raw, "memory.port"), 4100),
    host: str(pick(raw, "memory.host"), "127.0.0.1"),
    vaultPath,
    dbPath: expandHome(str(pick(raw, "memory.db_path"), join(vaultPath, ".index", "nexus-memory.db"))),
    models: {
      genUrl: str(pick(raw, "memory.models.gen_url"), "http://127.0.0.1:4001/v1"),
      embedUrl: str(pick(raw, "memory.models.embed_url"), "http://127.0.0.1:4002/v1"),
      embedModel: str(pick(raw, "memory.models.embed_model"), "nomic-embed-text-v1.5"),
      rerankUrl: str(pick(raw, "memory.models.rerank_url"), "http://127.0.0.1:4003/v1"),
      rerankModel: str(pick(raw, "memory.models.rerank_model"), "qwen3-reranker-0.6b"),
      apiKey: str(pick(raw, "memory.models.api_key") ?? pick(raw, "models.local.api_key"), "") || undefined,
      openrouter: loadOpenRouter(raw, str),
      prefer: pick(raw, "memory.models.prefer") === "local" ? "local" : "cloud",
    },
    retrieval: {
      hyde: bool(pick(raw, "memory.retrieval.hyde"), true),
      sentenceThreshold: num(pick(raw, "memory.retrieval.sentence_threshold"), 0.05),
      sentenceK: num(pick(raw, "memory.retrieval.sentence_k"), 100),
      chunkK: num(pick(raw, "memory.retrieval.chunk_k"), 20),
      rerankK: num(pick(raw, "memory.retrieval.rerank_k"), 25),
      rerankTimeoutMs: num(pick(raw, "memory.retrieval.rerank_timeout_ms"), 2000),
      tokenBudget: num(pick(raw, "memory.retrieval.token_budget"), 1500),
    },
  };
}

export const EMBED_DIM = 768;
