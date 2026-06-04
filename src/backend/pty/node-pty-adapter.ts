import * as nodePty from 'node-pty';
import type { PtyLike, SpawnFn } from './manager';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

/** Real PTY spawn backed by node-pty, adapted to the manager's PtyLike interface. */
export const spawnNodePty: SpawnFn = ({ cwd, cols, rows }) => {
  const proc = nodePty.spawn(SHELL, [], {
    name: 'xterm-color',
    cwd,
    cols,
    rows,
    env: process.env as { [key: string]: string },
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
