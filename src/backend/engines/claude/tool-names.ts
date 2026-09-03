/**
 * Three name spaces meet in the Claude engine:
 *   - Claude's tool names (`Bash`, `Edit`, `mcp__nexus__question`) — what the
 *     SDK reports and what `canUseTool` receives;
 *   - policy names (`bash`, `edit`, `question`) — Pi's lowercase names, which
 *     `tool-policy.ts` classifies and the audit trail records;
 *   - display names — what the transcript and the frontend see. Built-ins keep
 *     Claude's names (`runLabels.ts` already knows `Bash`/`Read`/`Edit`/`Write`);
 *     Nexus tools drop the MCP prefix so `question`, `memory_recall`, … render
 *     exactly as they do for Pi sessions.
 */
export const NEXUS_MCP_SERVER = 'nexus';
export const NEXUS_MCP_PREFIX = `mcp__${NEXUS_MCP_SERVER}__`;

const BUILTIN_TO_POLICY: Readonly<Record<string, string>> = {
  Bash: 'bash',
  KillShell: 'bash',
  BashOutput: 'read',
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  NotebookEdit: 'write',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
};

export function toDisplayToolName(claudeName: string): string {
  return claudeName.startsWith(NEXUS_MCP_PREFIX) ? claudeName.slice(NEXUS_MCP_PREFIX.length) : claudeName;
}

export function toPolicyToolName(claudeName: string): string {
  if (claudeName.startsWith(NEXUS_MCP_PREFIX)) return claudeName.slice(NEXUS_MCP_PREFIX.length);
  return BUILTIN_TO_POLICY[claudeName] ?? claudeName;
}

export function toClaudeToolName(nexusName: string): string {
  return `${NEXUS_MCP_PREFIX}${nexusName}`;
}
