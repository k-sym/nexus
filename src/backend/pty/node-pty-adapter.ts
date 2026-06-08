import * as nodePty from 'node-pty';
import type { PtyLike, SpawnFn } from './manager';
import { buildPtyEnv } from './env';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

/** Real PTY spawn backed by node-pty, adapted to the manager's PtyLike interface. */
export const spawnNodePty: SpawnFn = (ctx) => {
  const { cwd, cols, rows } = ctx;
  // Strip npm run-context vars that break nvm in an interactive shell
  // (npm_config_prefix=…/.hermes/node makes node CLIs unresolvable on PATH),
  // then apply per-thread overrides (e.g. NEXUS_MEMORY_*).
  const env = buildPtyEnv(process.env, ctx.env);
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
