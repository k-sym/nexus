/**
 * Persist provider credentials to ~/.nexus/auth.json with 0600 perms.
 * Mirrors zosma-cowork's auth.json pattern but generalized for any provider.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { getNexusDir } from '../config';

export type Credential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number; scope?: string; account_id?: string; [key: string]: unknown };

export type AuthFile = Record<string, Credential>;

export function authPath(): string {
  return join(getNexusDir(), 'auth.json');
}

export function loadAuth(): AuthFile {
  const p = authPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveAuth(auth: AuthFile): void {
  const p = authPath();
  mkdirSync(getNexusDir(), { recursive: true });
  writeFileSync(p, JSON.stringify(auth, null, 2), 'utf-8');
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on Windows
  }
}

export function setCredential(providerId: string, cred: Credential): void {
  const auth = loadAuth();
  auth[providerId] = cred;
  saveAuth(auth);
}

export function getCredential(providerId: string): Credential | undefined {
  return loadAuth()[providerId];
}

export function clearCredential(providerId: string): void {
  const auth = loadAuth();
  delete auth[providerId];
  saveAuth(auth);
}

/** Map provider id to a display name for the UI. */
export function providerDisplayName(providerId: string): string {
  const map: Record<string, string> = {
    anthropic: 'Anthropic (Claude Pro/Max)',
    'openai-codex': 'OpenAI Codex',
    'github-copilot': 'GitHub Copilot',
  };
  return map[providerId] || providerId;
}
