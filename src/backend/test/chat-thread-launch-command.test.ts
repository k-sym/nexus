import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';

test('chat_threads has a launch_command column', () => {
  const base = join(tmpdir(), `nexus-launchcmdtest-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = db.pragma('table_info(chat_threads)') as { name: string }[];
  const launchCommand = cols.find(c => c.name === 'launch_command');
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(launchCommand, 'launch_command column present');
});
