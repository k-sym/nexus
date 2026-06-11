import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === '#' && quote === null && /\s/.test(value[i - 1] ?? ' ')) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (!((first === '"' && last === '"') || (first === "'" && last === "'"))) return value;
  const inner = value.slice(1, -1);
  return first === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
}

export function findLocalEnvFile(startDir = process.cwd()): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return null;
    dir = parent;
  }
}

export function loadLocalEnvFile(envPath = findLocalEnvFile()): boolean {
  if (!envPath || !existsSync(envPath)) return false;
  const raw = readFileSync(envPath, 'utf-8');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(stripInlineComment(rawValue));
  }

  return true;
}
