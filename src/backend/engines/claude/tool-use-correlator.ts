/**
 * Pairs Claude `tool_use_id`s (seen by the PreToolUse hook) with in-process
 * MCP invocations (which see only the arguments). Exact-input match first,
 * FIFO per tool name as the fallback for identical parallel calls.
 */
export class ToolUseCorrelator {
  private readonly queues = new Map<string, Array<{ id: string; key: string }>>();

  remember(toolName: string, toolUseId: string, input: unknown): void {
    const queue = this.queues.get(toolName) ?? [];
    queue.push({ id: toolUseId, key: stableKey(input) });
    this.queues.set(toolName, queue);
  }

  claim(toolName: string, input: unknown): string | undefined {
    const queue = this.queues.get(toolName);
    if (!queue || queue.length === 0) return undefined;
    const key = stableKey(input);
    const index = queue.findIndex((entry) => entry.key === key);
    const [entry] = queue.splice(index >= 0 ? index : 0, 1);
    return entry?.id;
  }

  clear(): void {
    this.queues.clear();
  }
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v));
  } catch {
    return String(value);
  }
}
