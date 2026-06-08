import { ScrollbackBuffer } from './scrollback';

export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnCtx {
  cwd: string;
  cols: number;
  rows: number;
  launchCommand: string;
  /** Extra env vars merged over the sanitized base env at spawn (e.g. NEXUS_MEMORY_*). */
  env?: Record<string, string>;
}

export type SpawnFn = (ctx: SpawnCtx) => PtyLike;

interface Session {
  pty: PtyLike;
  buffer: ScrollbackBuffer;
  clients: Set<(data: string) => void>;
  lastActive: number;
  launched: boolean;
}

/** When the launch command is written after spawn (lets the shell print its first prompt). */
const LAUNCH_DELAY_MS = 400;

export class PtyManager {
  private sessions = new Map<string, Session>();
  constructor(private readonly opts: { spawn: SpawnFn; now?: () => number }) {}

  private clock(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Ensure a session exists for threadId; spawn + pre-type the launch command if new. */
  open(threadId: string, ctx: SpawnCtx): void {
    if (this.sessions.has(threadId)) return;
    const pty = this.opts.spawn(ctx);
    const session: Session = { pty, buffer: new ScrollbackBuffer(), clients: new Set(), lastActive: this.clock(), launched: false };
    pty.onData(data => {
      session.buffer.append(data);
      session.lastActive = this.clock();
      for (const send of session.clients) send(data);
    });
    pty.onExit(() => this.sessions.delete(threadId));
    this.sessions.set(threadId, session);

    if (ctx.launchCommand) {
      const write = () => { if (this.sessions.has(threadId)) { pty.write(ctx.launchCommand); session.launched = true; } };
      // setTimeout in prod; tests inject now() and rely on immediate write below.
      if (this.opts.now) write();
      else setTimeout(write, LAUNCH_DELAY_MS);
    }
  }

  /** Register a client and replay scrollback. */
  attach(threadId: string, send: (data: string) => void): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    const snap = s.buffer.snapshot();
    if (snap) send(snap);
    s.clients.add(send);
    s.lastActive = this.clock();
  }

  detach(threadId: string, send: (data: string) => void): void {
    this.sessions.get(threadId)?.clients.delete(send);
  }

  input(threadId: string, data: string): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    s.pty.write(data);
    s.lastActive = this.clock();
  }

  resize(threadId: string, cols: number, rows: number): void {
    this.sessions.get(threadId)?.pty.resize(cols, rows);
  }

  /** Kill + forget a session (explicit close / thread delete). */
  close(threadId: string): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    this.sessions.delete(threadId);
    s.pty.kill();
  }

  /** Reap sessions with no clients idle beyond maxIdleMs. */
  reap(maxIdleMs: number): void {
    const cutoff = this.clock() - maxIdleMs;
    for (const [id, s] of this.sessions) {
      if (s.clients.size === 0 && s.lastActive < cutoff) this.close(id);
    }
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
