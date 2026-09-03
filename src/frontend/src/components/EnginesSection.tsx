import { useEffect, useState } from 'react';
import { apiFetch } from '../api-base';

interface EngineStatus {
  id: string; enabled: boolean; auth: 'subscription' | 'api_key';
  tokenConfigured: boolean; authSource: 'token' | 'login' | 'api_key';
  executablePath: string | null; modelCount: number;
}
interface EnginesResponse { engines: EngineStatus[]; piAnthropicOAuthHidden: boolean }

const AUTH_TEXT: Record<EngineStatus['authSource'], string> = {
  token: 'CLAUDE_CODE_OAUTH_TOKEN is set in the backend environment (from claude setup-token).',
  login: "Using this machine's claude login (no CLAUDE_CODE_OAUTH_TOKEN configured).",
  api_key: 'API key mode: ANTHROPIC_API_KEY from the backend environment is used, not a subscription.',
};

export function EnginesSection() {
  const [data, setData] = useState<EnginesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/engines').then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as EnginesResponse;
      if (!cancelled) setData(body);
    }).catch((err) => { if (!cancelled) setError(err?.message ?? 'failed'); });
    return () => { cancelled = true; };
  }, []);
  if (error) return <div className="text-xs text-red-300">Engine status unavailable: {error}</div>;
  if (!data) return <div className="text-xs text-zinc-500">Loading engine status…</div>;
  const claude = data.engines.find((e) => e.id === 'claude-code');
  if (!claude) return null;
  return (
    <div className="space-y-2 text-xs text-zinc-300">
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-200 w-40">Claude Code</span>
        <span className={claude.enabled ? 'text-green-400' : 'text-zinc-500'}>{claude.enabled ? '✓ Enabled' : 'Disabled'}</span>
        <span className="text-zinc-500">· {claude.modelCount} models as claude-code/*</span>
      </div>
      <p className="text-zinc-400">{AUTH_TEXT[claude.authSource]}</p>
      {claude.executablePath && <p className="text-zinc-500">Executable: <span className="font-mono">{claude.executablePath}</span></p>}
      {data.piAnthropicOAuthHidden && (
        <p className="text-amber-300/90">Anthropic subscription models via Pi are hidden while this engine is on. Remove the Pi Anthropic login under Provider Auth to tidy up; an Anthropic API key is unaffected.</p>
      )}
      <p className="text-zinc-500">Configure in <span className="font-mono">~/.nexus/config.yaml</span> under <span className="font-mono">engines.claude</span>; the token itself lives in the backend's <span className="font-mono">.env</span>.</p>
    </div>
  );
}
