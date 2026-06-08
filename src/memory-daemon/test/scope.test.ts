import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpEnvDefaults, mergeScope } from "../src/mcp/scope.js";

test("mcpEnvDefaults: project pins nexus namespace + isolated scope", () => {
  assert.deepEqual(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "baker-internal" }), {
    namespace: "nexus", project: "baker-internal", scope: "isolated", readonly: false,
  });
});

test("mcpEnvDefaults: readonly flag (1 or true)", () => {
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "x", NEXUS_MEMORY_READONLY: "1" }).readonly, true);
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "x", NEXUS_MEMORY_READONLY: "true" }).readonly, true);
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "x" }).readonly, false);
});

test("mcpEnvDefaults: no project → only readonly flag, no scope defaults", () => {
  assert.deepEqual(mcpEnvDefaults({}), { readonly: false });
  assert.deepEqual(mcpEnvDefaults({ NEXUS_MEMORY_READONLY: "1" }), { readonly: true });
});

test("mcpEnvDefaults: trims the project slug", () => {
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "  baker-internal  " }).project, "baker-internal");
});

test("mergeScope: explicit args override env defaults", () => {
  const d = { namespace: "nexus", project: "a", scope: "isolated" as const, readonly: false };
  assert.deepEqual(mergeScope({ project: "b", scope: "cross" }, d), { namespace: "nexus", project: "b", scope: "cross" });
});

test("mergeScope: defaults fill gaps when args omit them", () => {
  const d = { namespace: "nexus", project: "a", scope: "isolated" as const, readonly: false };
  assert.deepEqual(mergeScope({}, d), { namespace: "nexus", project: "a", scope: "isolated" });
});

test("mergeScope: no defaults → passes args through (undefined stays undefined)", () => {
  assert.deepEqual(mergeScope({ project: "b" }, { readonly: false }), { namespace: undefined, project: "b", scope: undefined });
});
