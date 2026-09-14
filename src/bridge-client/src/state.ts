import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientConfig } from './config.js';
import type { Envelope, Result } from './protocol.js';
export class State {
  readonly db: Database.Database;
  readonly namespace: string;
  private releases = new Set<() => void>();
  constructor(config: ClientConfig) {
    this.namespace = createHash('sha256').update(JSON.stringify([config.url, config.instance_id, config.sender_id])).digest('hex');
    mkdirSync(config.state_dir, { recursive: true, mode: 0o700 });
    chmodSync(config.state_dir, 0o700);
    const path = join(config.state_dir, `${this.namespace}.sqlite`);
    this.db = new Database(path); chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reader (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  saveSend(message: Envelope): void { this.db.prepare('INSERT INTO sends(id, payload) VALUES (?, ?)').run(message.id, JSON.stringify(message)); }
  send(id: string): Envelope | undefined {
    const row = this.db.prepare('SELECT payload FROM sends WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  published(id: string): void { this.db.prepare('UPDATE sends SET published = 1 WHERE id = ?').run(id); }
  receive(result: Result): void { this.db.prepare('INSERT OR IGNORE INTO results(id, payload) VALUES (?, ?)').run(result.id, JSON.stringify(result)); }
  unread(): Result[] { return (this.db.prepare('SELECT payload FROM results WHERE delivered = 0 ORDER BY rowid LIMIT 100').all() as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  delivered(ids: string[]): void {
    this.db.transaction(() => { const update = this.db.prepare('UPDATE results SET delivered = 1 WHERE id = ?'); for (const id of ids) update.run(id); })();
  }
  lockReader(): () => void {
    const owner = randomUUID();
    const acquired = this.db.prepare(`INSERT INTO reader(id, owner, expires) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE reader.expires < ?`)
      .run(owner, Date.now() + 30000, Date.now());
    if (!acquired.changes) throw new Error('Another result reader is active for this sender. Retry after it exits (up to 30 seconds after a crash).');
    const timer = setInterval(() => {
      this.db.prepare('UPDATE reader SET expires = ? WHERE id = 1 AND owner = ?').run(Date.now() + 30000, owner);
    }, 5000); timer.unref();
    let released = false;
    const release = () => {
      if (released) return; released = true; clearInterval(timer);
      this.db.prepare('DELETE FROM reader WHERE id = 1 AND owner = ?').run(owner);
      this.releases.delete(release);
    };
    this.releases.add(release); return release;
  }
  close(): void { for (const release of this.releases) release(); this.db.close(); }
}
