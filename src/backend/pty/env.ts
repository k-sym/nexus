/**
 * Build the environment for a PTY shell: start from `base`, drop `npm_config_*`
 * (Hermes' npm_config_prefix breaks nvm so node CLIs don't resolve), then apply
 * `extra` overrides (e.g. per-thread NEXUS_MEMORY_* scoping).
 */
export function buildPtyEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.toLowerCase().startsWith('npm_config_')) continue;
    env[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
