/**
 * Turns the Nexus tools a Pi session would get into an in-process MCP server
 * for the Claude Agent SDK. Same extension factories, same `execute`
 * functions, same brokers — so `question`, `memory_recall`, Docker, browser,
 * Monday and the API helpers behave identically under both engines and a
 * tool added for Pi shows up for Claude with no extra work.
 *
 * TypeBox schemas are JSON Schema; `z.fromJSONSchema` (zod 4) turns them into
 * the zod raw shape the SDK's `tool()` wants, so the model sees the same
 * parameter descriptions Pi advertises.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentToolResult, ExtensionContext, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { NEXUS_MCP_SERVER, toClaudeToolName } from './tool-names.js';
import type { ToolUseCorrelator } from './tool-use-correlator.js';

export type PiToolDefinition = ToolDefinition<any, any, any>;

export interface BridgeContext {
  cwd: string;
  correlator: ToolUseCorrelator;
  /** The current turn's abort signal, read per call so a session can outlive a turn. */
  signal: () => AbortSignal | undefined;
  onUpdate: (toolCallId: string, toolName: string, partial: AgentToolResult<unknown>) => void;
  /** Pi tools return structured `details` beside text; MCP only carries the text
   *  back through Claude, so details travel on this side channel. */
  onDetails: (toolCallId: string, details: unknown) => void;
}

/** A callable proxy whose every property is itself: absorbs `pi.on(...)`,
 *  `pi.registerCommand(...)`, `pi.ui.notify(...)` and any nested access. */
function absorbAll(onRegisterTool?: (def: PiToolDefinition) => void): any {
  const proxy: any = new Proxy(function noop() {}, {
    get: (_target, prop) => (prop === 'registerTool' && onRegisterTool ? onRegisterTool : proxy),
    apply: () => undefined,
  });
  return proxy;
}

/**
 * Run each factory against a recorder that keeps `registerTool()` calls and
 * ignores everything else. A factory that throws costs its own tools only.
 */
export async function collectPiTools(factories: ExtensionFactory[]): Promise<PiToolDefinition[]> {
  const tools: PiToolDefinition[] = [];
  const recorder = absorbAll((def) => { tools.push(def); });
  for (const factory of factories) {
    try {
      await factory(recorder);
    } catch {
      /* a factory that needs the real runtime costs its tools, not the session */
    }
  }
  return tools;
}

export function zodShapeFor(schema: unknown): z.ZodRawShape {
  // TypeBox schemas carry symbol-keyed metadata; a JSON round trip leaves plain JSON Schema.
  const plain = JSON.parse(JSON.stringify(schema));
  const parsed = z.fromJSONSchema(plain);
  if (!(parsed instanceof z.ZodObject)) throw new Error('tool parameters must be an object schema');
  return parsed.shape as z.ZodRawShape;
}

function extensionContextStub(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, ui: absorbAll() } as unknown as ExtensionContext;
}

function toMcpContent(content: AgentToolResult<unknown>['content']) {
  return content.map((block) => block.type === 'image'
    ? { type: 'image' as const, data: block.data, mimeType: block.mimeType }
    : { type: 'text' as const, text: block.text });
}

export function buildNexusToolDefinitions(tools: PiToolDefinition[], ctx: BridgeContext): SdkMcpToolDefinition<any>[] {
  return tools.map((def) => tool(def.name, def.description, zodShapeFor(def.parameters), async (args) => {
    const toolCallId = ctx.correlator.claim(toClaudeToolName(def.name), args) ?? `nexus-${randomUUID()}`;
    try {
      const result = await def.execute(
        toolCallId,
        args as any,
        ctx.signal(),
        (partial) => ctx.onUpdate(toolCallId, def.name, partial),
        extensionContextStub(ctx.cwd),
      );
      if (result.details !== undefined) ctx.onDetails(toolCallId, result.details);
      return {
        content: toMcpContent(result.content),
        isError: (result as { isError?: boolean }).isError === true,
      };
    } catch (err: any) {
      // Pi's loop turns a throw into an error tool result; do the same for MCP.
      return { content: [{ type: 'text' as const, text: err?.message || String(err) }], isError: true };
    }
  }));
}

export function createNexusMcpServer(tools: PiToolDefinition[], ctx: BridgeContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: NEXUS_MCP_SERVER,
    version: '1.0.0',
    tools: buildNexusToolDefinitions(tools, ctx),
  });
}
