import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { PersonaConfig } from '@nexus/shared';
import { getProviderById } from '../routes/providers';
import { buildLaunchCommand } from './launch-command';

/** Resolve the terminal launch command for a persona, mirroring chat's provider/model/args resolution. */
export function resolveLaunchCommand(db: Database.Database, configYaml: string, sessionId?: string | null): string {
  let cfg: Partial<PersonaConfig> = {};
  try { cfg = (yaml.load(configYaml) as Partial<PersonaConfig>) ?? {}; } catch { /* defaults */ }
  const provider = cfg.provider_id ? getProviderById(db, cfg.provider_id) : undefined;
  const providerKind = provider?.kind ?? cfg.provider ?? '';
  const model = cfg.model || provider?.default_model || '';
  const args = provider?.args ?? null;
  return buildLaunchCommand({ providerKind, model, args, systemPrompt: cfg.system_prompt, sessionId });
}
