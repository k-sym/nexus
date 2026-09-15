import { ROLE_NAMES, type RoleName } from '@nexus/shared';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { toPolicyToolName } from '../engines/claude/tool-names.js';
export const ROLE_TOOLS = { scout: 'scout', researcher: 'research', builder: 'build', refuter: 'refute', debugger: 'debug' } as const;
const blocked = new Set<string>([...ROLE_NAMES, ...Object.values(ROLE_TOOLS), 'Agent', 'Task', 'AskUserQuestion', 'Skill', 'ToolSearch']);
const sets: Partial<Record<RoleName, Set<string>>> = {
  scout: new Set(['read', 'grep', 'find', 'ls']),
  researcher: new Set(['read', 'grep', 'find', 'web_fetch', 'web_search', 'memory_recall']),
  refuter: new Set(['read', 'grep', 'find', 'bash']),
};
export function allowsRoleTool(role: RoleName, name: string): boolean {
  const normalized = toPolicyToolName(name);
  if (blocked.has(normalized) || blocked.has(name)) return false;
  return sets[role]?.has(normalized) ?? true;
}
export function restrictedFactories(factories: ExtensionFactory[], role: RoleName): ExtensionFactory[] {
  const filtered: ExtensionFactory[] = factories.map(factory => async (api) => {
    await factory(new Proxy(api, { get(target, key) {
      if (key === 'registerTool') return (tool: any) => { if (allowsRoleTool(role, tool.name)) target.registerTool(tool); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }));
  });
  filtered.push(api => { api.on('tool_call', async event => {
    if (!allowsRoleTool(role, event.toolName)) return { block: true, reason: `Tool unavailable to ${role}` };
  }); });
  return filtered;
}
export const ROLE_PURPOSES: Record<RoleName, string> = {
  scout: 'Find files, symbols and call sites. Report precise locations and concise findings; do not dump files.',
  researcher: 'Read source and documentation. Cite facts and explicitly mark anything unverified.',
  builder: 'Implement the supplied specification and run relevant tests. Report changes and evidence.',
  refuter: 'Independently review the diff and rerun relevant tests. A done claim is not evidence. Report defects with locations; do not edit files.',
  debugger: 'Investigate root causes, fix the cause when authorized by the brief, and verify the result.',
};
export const ROLES_APPENDIX = 'Nexus roles are available: scout, research, build, refute, debug. Delegate focused briefs; role models are selected by the human. Calls must be sequential. Use refute for independent evidence before claiming implementation complete. Treat incomplete or failed reports as unfinished work.';
