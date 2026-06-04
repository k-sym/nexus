import yaml from 'js-yaml';

export interface PersonaLaunch {
  provider: string;
  systemPrompt: string;
}

/** Extract the launch-relevant fields (provider + system prompt) from a persona's config_yaml. */
export function parsePersonaLaunch(configYaml: string): PersonaLaunch {
  let cfg: { provider?: unknown; system_prompt?: unknown } = {};
  try { cfg = (yaml.load(configYaml) as typeof cfg) ?? {}; } catch { /* defaults */ }
  return {
    provider: typeof cfg.provider === 'string' ? cfg.provider : '',
    systemPrompt: typeof cfg.system_prompt === 'string' ? cfg.system_prompt : '',
  };
}
