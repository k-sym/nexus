/**
 * APNs sender (M5) — no third-party dependency. Signs the provider JWT with
 * `node:crypto` (ES256 over the .p8 auth key) and posts to Apple over
 * `node:http2`. Inert until `apns.enabled` with a resolvable key: `notify()` is
 * a no-op (single debug line) otherwise, so the feature ships dark.
 *
 * Config is re-read per `notify()` so a Settings change takes effect without a
 * restart. Per-device `env` picks the sandbox vs production host.
 */
import * as http2 from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { loadConfig, resolveEnvVars, expandHome } from '../config.js';
import { listDevices, deleteDeviceByToken, type DeviceRow } from '../devices/index.js';

const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const PRODUCTION_HOST = 'https://api.push.apple.com';
/** Refresh the provider token well inside Apple's 1-hour ceiling. */
const JWT_MAX_AGE_MS = 50 * 60 * 1000;

interface ResolvedApns {
  keyId: string;
  teamId: string;
  bundleId: string;
  pem: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Routing target read by the iOS app, e.g. `thread:<id>` or `approval:<id>`. */
  deepLink: string;
  /** Groups notifications in the iOS UI (usually the threadId). */
  threadId?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Resolve config → key material, or null when disabled/unconfigured. */
function resolveApns(): ResolvedApns | null {
  const cfg = loadConfig().apns;
  if (!cfg?.enabled) return null;

  let pem = '';
  if (cfg.key_path?.trim()) {
    try {
      pem = readFileSync(expandHome(cfg.key_path.trim()), 'utf8');
    } catch {
      return null;
    }
  } else {
    pem = resolveEnvVars(cfg.key || '').trim();
  }
  if (!pem || !cfg.key_id?.trim() || !cfg.team_id?.trim() || !cfg.bundle_id?.trim()) return null;

  return { keyId: cfg.key_id.trim(), teamId: cfg.team_id.trim(), bundleId: cfg.bundle_id.trim(), pem };
}

/** Sign the APNs provider JWT (ES256). Exported for unit testing. */
export function signApnsJwt(pem: string, keyId: string, teamId: string, iat = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat }));
  const signingInput = `${header}.${payload}`;
  const key: KeyObject = createPrivateKey(pem);
  // `ieee-p1363` yields the raw 64-byte r||s signature JWT ES256 requires
  // (the default DER encoding would be rejected by Apple).
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

export class ApnsSender {
  private jwt?: { token: string; mintedAt: number };

  constructor(private readonly db: Database.Database) {}

  /** True when the feature is enabled with a resolvable key. */
  get configured(): boolean {
    return resolveApns() != null;
  }

  private providerToken(cfg: ResolvedApns): string {
    if (this.jwt && Date.now() - this.jwt.mintedAt < JWT_MAX_AGE_MS) return this.jwt.token;
    const token = signApnsJwt(cfg.pem, cfg.keyId, cfg.teamId);
    this.jwt = { token, mintedAt: Date.now() };
    return token;
  }

  /** Send an alert push to every registered device. Never throws. */
  async notify(message: PushMessage): Promise<void> {
    const cfg = resolveApns();
    if (!cfg) return; // dormant — feature off or unconfigured
    const devices = listDevices(this.db);
    if (devices.length === 0) return;

    const token = this.providerToken(cfg);
    const payload = JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: 'default',
        ...(message.threadId ? { 'thread-id': message.threadId } : {}),
      },
      nexus: { deepLink: message.deepLink },
    });

    // Group by host (sandbox vs production) so we reuse one HTTP/2 session each.
    const byHost = new Map<string, DeviceRow[]>();
    for (const device of devices) {
      const host = device.env === 'production' ? PRODUCTION_HOST : SANDBOX_HOST;
      (byHost.get(host) ?? byHost.set(host, []).get(host)!).push(device);
    }

    await Promise.all(
      [...byHost.entries()].map(([host, hostDevices]) =>
        this.sendBatch(host, token, cfg, hostDevices, payload).catch((err) => {
          console.warn('[apns] send failed:', err instanceof Error ? err.message : err);
        }),
      ),
    );
  }

  private sendBatch(host: string, token: string, cfg: ResolvedApns, devices: DeviceRow[], payload: string): Promise<void> {
    return new Promise((resolve) => {
      const client = http2.connect(host);
      client.on('error', (err) => {
        console.warn('[apns] connection error:', err.message);
        resolve();
      });
      const body = Buffer.from(payload);
      let pending = devices.length;
      const done = () => { if (--pending <= 0) { client.close(); resolve(); } };

      for (const device of devices) {
        const req = client.request({
          ':method': 'POST',
          ':path': `/3/device/${device.token}`,
          authorization: `bearer ${token}`,
          'apns-topic': cfg.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
          'content-length': body.length,
        });
        let status = 0;
        let data = '';
        req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => {
          if (status === 410 || (status === 400 && data.includes('BadDeviceToken'))) {
            // Apple says this token is dead — stop sending to it.
            deleteDeviceByToken(this.db, device.token);
          } else if (status !== 200) {
            console.warn(`[apns] ${status} for device: ${data}`);
          }
          done();
        });
        req.on('error', (err) => { console.warn('[apns] request error:', err.message); done(); });
        req.end(body);
      }
    });
  }
}
