import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';

test('chat_threads has a mode column defaulting to chat', () => {
  const base = join(tmpdir(), `nexus-modetest-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = db.pragma('table_info(chat_threads)') as { name: string; dflt_value: string | null }[];
  const mode = cols.find(c => c.name === 'mode');
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(mode, 'mode column present');
  assert.match(String(mode!.dflt_value ?? ''), /chat/, "mode defaults to 'chat'");
});
