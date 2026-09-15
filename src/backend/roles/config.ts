import { ROLE_NAMES, type RoleOverrides, type RolesConfig, type ThreadRoles } from '@nexus/shared';
import type { EngineRegistry } from '../engines/registry.js';
export function validateRoleOverrides(value: unknown, engines: EngineRegistry): RoleOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Role models must be an object');
  const result: RoleOverrides = {};
  for (const [key, model] of Object.entries(value)) {
    if (!ROLE_NAMES.includes(key as any)) throw new Error(`Unknown role: ${key}`);
    if (model === null) continue;
    if (typeof model !== 'string' || !engines.listModels().some(m => `${m.provider}/${m.id}` === model)) throw new Error(`Unknown model for ${key}`);
    result[key as keyof RoleOverrides] = model;
  }
  return result;
}
/** Per-thread overrides from the `chat_threads.role_models` column. Corrupt JSON is dropped (and logged) rather than failing the read: the thread then runs on the defaults. */
export function readOverrides(raw: unknown, context?: string, log: (line: string) => void = line => console.warn(line)): RoleOverrides {
  if (typeof raw !== 'string') return {};
  try { const parsed = JSON.parse(raw); return Object.fromEntries(ROLE_NAMES.filter(r => typeof parsed?.[r] === 'string').map(r => [r, parsed[r]])); }
  catch (error) { log(`[roles] ignoring corrupt role_models${context ? ` for ${context}` : ''}: ${error instanceof Error ? error.message : String(error)}`); return {}; }
}
export function roleView(config: RolesConfig, overrides: RoleOverrides, engines: EngineRegistry): ThreadRoles {
  const effective = { ...config.models, ...overrides };
  const available = Object.fromEntries(ROLE_NAMES.map(r => [r, engines.listModels().some(m => `${m.provider}/${m.id}` === effective[r] && m.configured !== false)])) as ThreadRoles['available'];
  return { enabled: config.enabled, defaults: config.models, overrides, effective, available };
}
/**
 * Shape and bounds check for `roles` in config.yaml. With an engine registry, a
 * role's model must also be a registered `provider/id` — unless it is the
 * selection already saved in `previous`: a model that has since disappeared
 * from the catalog stays (visible as unavailable) and only fails on invocation.
 */
export function validateRolesConfig(config: RolesConfig, engines?: EngineRegistry, previous?: RolesConfig): string | undefined {
  if (!config || typeof config.enabled !== 'boolean') return 'Roles enabled must be a boolean';
  for (const [key, max] of [['max_turns', 1000], ['max_minutes', 1440], ['max_tokens', 10000000]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) return `roles.${key} must be an integer between 1 and ${max}`;
  }
  if (!config.models) return 'Each role needs a provider/model key';
  const known = engines && new Set(engines.listModels().map(m => `${m.provider}/${m.id}`));
  for (const role of ROLE_NAMES) {
    const key = config.models[role];
    if (typeof key !== 'string' || !key.includes('/')) return 'Each role needs a provider/model key';
    if (known && !known.has(key) && key !== previous?.models?.[role]) return `Unknown model for ${role}: ${key}`;
  }
}
