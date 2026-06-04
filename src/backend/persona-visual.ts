import yaml from 'js-yaml';
import { DEFAULT_PERSONA_COLOR } from '@nexus/shared';

export interface PersonaVisual {
  icon: string | undefined;
  color: string;
}

/** Derive a persona's visual identity (icon name + accent colour) from its config_yaml. */
export function parsePersonaVisual(configYaml: string): PersonaVisual {
  let cfg: { icon?: unknown; color?: unknown } = {};
  try {
    cfg = (yaml.load(configYaml) as typeof cfg) ?? {};
  } catch {
    /* malformed yaml — fall through to defaults */
  }
  return {
    icon: typeof cfg.icon === 'string' ? cfg.icon : undefined,
    color: typeof cfg.color === 'string' ? cfg.color : DEFAULT_PERSONA_COLOR,
  };
}
