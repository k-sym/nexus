// Regression tests for the MCP memory_store namespace defaulting (2026-08-14 incident:
// stores with an omitted namespace landed in `openclaw`, invisible to global recall).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.js";
import type { MemoryClient, StoreInput } from "../src/client.js";
import type { McpEnvDefaults } from "../src/mcp/scope.js";

async function callStore(args: Record<string, unknown>, defaults?: McpEnvDefaults): Promise<StoreInput> {
  let captured: StoreInput | undefined;
  const fake = {
    store: async (input: StoreInput) => {
      captured = input;
      return { id: "01TEST", action: "created" };
    },
  } as unknown as MemoryClient;

  const server = buildMcpServer(fake, defaults ? { defaults } : undefined);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: "memory_store", arguments: args });
    assert.equal(res.isError ?? false, false, JSON.stringify(res.content));
  } finally {
    await client.close();
    await server.close();
  }
  assert.ok(captured, "store was not called");
  return captured!;
}

test("memory_store: omitted namespace defaults to global (not openclaw)", async () => {
  const input = await callStore({ body: "hello" });
  assert.equal(input.namespace, "global");
  assert.equal(input.project, null);
  assert.equal(input.source, "mcp");
});

test("memory_store: explicit namespace arg wins", async () => {
  const input = await callStore({ body: "hello", namespace: "openclaw", source: "openclaw" });
  assert.equal(input.namespace, "openclaw");
  assert.equal(input.source, "openclaw");
});

test("memory_store: env project pin scopes stores like reads", async () => {
  const defaults: McpEnvDefaults = { namespace: "nexus", project: "baker-internal", scope: "isolated", readonly: false };
  const input = await callStore({ body: "hello" }, defaults);
  assert.equal(input.namespace, "nexus");
  assert.equal(input.project, "baker-internal");
});
