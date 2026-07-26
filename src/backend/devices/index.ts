/**
 * APNs device-token store for the iOS thin client. Tokens are registered via
 * POST /api/devices and removed on sign-out (DELETE) or when Apple reports them
 * unregistered (410, handled by the sender). Keyed by the token so a
 * re-registration upserts rather than duplicating.
 */
import type Database from 'better-sqlite3';

export type DeviceEnv = 'sandbox' | 'production';

export interface DeviceRow {
  token: string;
  platform: string;
  env: DeviceEnv;
  created_at: string;
  updated_at: string;
}

/** Register (or refresh) a device token. Idempotent on the token. */
export function registerDevice(
  db: Database.Database,
  input: { token: string; platform?: string; env?: DeviceEnv },
): DeviceRow {
  const now = new Date().toISOString();
  const platform = input.platform || 'ios';
  const env: DeviceEnv = input.env === 'production' ? 'production' : 'sandbox';
  db.prepare(
    `INSERT INTO devices (token, platform, env, created_at, updated_at)
     VALUES (@token, @platform, @env, @now, @now)
     ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, env = excluded.env, updated_at = excluded.updated_at`,
  ).run({ token: input.token, platform, env, now });
  return db.prepare('SELECT * FROM devices WHERE token = ?').get(input.token) as DeviceRow;
}

/** All registered devices (used to broadcast a push). */
export function listDevices(db: Database.Database): DeviceRow[] {
  return db.prepare('SELECT * FROM devices ORDER BY updated_at DESC').all() as DeviceRow[];
}

/** Remove a device token. No-op if absent. */
export function deleteDeviceByToken(db: Database.Database, token: string): void {
  db.prepare('DELETE FROM devices WHERE token = ?').run(token);
}
