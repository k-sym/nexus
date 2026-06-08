#!/usr/bin/env node
// MCP stdio entry point — the transport CLI agents (Claude Code / Codex) register.
// It talks to the running daemon over HTTP, so it adds no DB handle of its own.
// NOTE: stdout is the MCP protocol channel — all logging must go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { MemoryClient } from "../client.js";
import { buildMcpServer } from "./server.js";
import { mcpEnvDefaults } from "./scope.js";

async function main() {
  const cfg = loadConfig();
  const baseUrl = process.env.MEMORY_DAEMON_URL ?? `http://${cfg.host}:${cfg.port}`;
  const client = new MemoryClient(baseUrl);
  const defaults = mcpEnvDefaults(process.env);
  const server = buildMcpServer(client, { defaults });
  await server.connect(new StdioServerTransport());
  console.error(
    `[nexus-memory-mcp] connected; daemon=${baseUrl}; project=${defaults.project ?? "(all)"}; readonly=${defaults.readonly}`,
  );
}

main().catch((err) => {
  console.error("[nexus-memory-mcp] fatal:", err);
  process.exit(1);
});
