// Daemon configuration. Reads ~/.nexus/config.yaml if present (shared with Nexus),
// applies env interpolation (${VAR}), and falls back to the verified local stack defaults.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

export interface DaemonConfig {
  /** HTTP/MCP bind port for the daemon. */
  port: number;
  host: string;
  /** Canonical Obsidian vault root (markdown is the source of truth). */
  vaultPath: string;
  /** Where the disposable SQLite index lives (inside the vault by default). */
  dbPath: string;
  models: {
    /** 9B gen — HyDE + KG extraction. */
    genUrl: string;
    /** nomic-embed 768-dim. */
    embedUrl: string;
    embedModel: string;
    /** Qwen3 reranker. */
    rerankUrl: string;
    rerankModel: string;
    apiKey?: string;
  };
  retrieval: {
    hyde: boolean;
    sentenceThreshold: number;
    sentenceK: number;
    chunkK: number;
    rerankK: number;
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

  // Vault root is TBD pending Keith's brain dump; default to the README location.
  const vaultPath = expandHome(
    str(pick(raw, "memory.vault_path") ?? pick(raw, "obsidian.vault_path"), join(nexusHome, "obsidian")),
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
    },
    retrieval: {
      hyde: bool(pick(raw, "memory.retrieval.hyde"), true),
      sentenceThreshold: num(pick(raw, "memory.retrieval.sentence_threshold"), 0.05),
      sentenceK: num(pick(raw, "memory.retrieval.sentence_k"), 100),
      chunkK: num(pick(raw, "memory.retrieval.chunk_k"), 20),
      rerankK: num(pick(raw, "memory.retrieval.rerank_k"), 25),
      tokenBudget: num(pick(raw, "memory.retrieval.token_budget"), 1500),
    },
  };
}

export const EMBED_DIM = 768;
