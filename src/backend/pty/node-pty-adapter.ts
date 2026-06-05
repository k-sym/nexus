import * as nodePty from 'node-pty';
import type { PtyLike, SpawnFn } from './manager';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

/** Real PTY spawn backed by node-pty, adapted to the manager's PtyLike interface. */
export const spawnNodePty: SpawnFn = ({ cwd, cols, rows }) => {
  // Strip npm run-context vars that break nvm in an interactive shell
  // (npm_config_prefix=…/.hermes/node makes node CLIs unresolvable on PATH).
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toLowerCase().startsWith('npm_config_')) continue;
    env[k] = v;
  }
  const proc = nodePty.spawn(SHELL, [], {
    name: 'xterm-color',
    cwd,
    cols,
    rows,
    env,
  });
  const adapter: PtyLike = {
    onData: cb => proc.onData(cb),
    onExit: cb => proc.onExit(() => cb()),
    write: data => proc.write(data),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill(),
  };
  return adapter;
};
