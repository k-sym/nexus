/**
 * What the agent's browser is allowed to load.
 *
 * A browser is a general-purpose fetch-and-execute engine pointed at whatever
 * string the model produces, so this is the security boundary for #265 in the
 * way `resolveComposeFile` is for #264. Two separate rules, both enforced here:
 *
 *   1. **Scheme.** Only http and https. `file://` would turn the browser into
 *      an unrestricted filesystem reader — the model could read any path the
 *      backend can, straight past every containment rule elsewhere in Nexus.
 *      `chrome://`, `devtools://` and friends reach browser internals, and
 *      `data:`/`javascript:` are script-execution vectors.
 *
 *   2. **Host.** Loopback only, unless the project has explicitly listed other
 *      hosts. The default use case is "run the dev server and look at it", and
 *      that needs nothing else. Anything wider is a decision someone should
 *      make on purpose, not a default they inherit.
 *
 * Both rules are applied to the URL *after* parsing, so tricks that rely on the
 * raw string being read differently by us and by the browser don't help.
 */

/** Schemes the browser may load. Deliberately a tiny allowlist, not a denylist
 *  of the dangerous ones — new schemes appear and would default to permitted. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hosts that need no configuration: the machine Nexus is running on. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

export type UrlVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/** `.example.com` matches any subdomain; `example.com` matches exactly. */
function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8 is all loopback, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // *.localhost is reserved for loopback (RFC 6761) and is how some dev servers
  // do per-app subdomains.
  return h === 'localhost' || h.endsWith('.localhost');
}

/**
 * Decide whether the browser may load `raw`.
 *
 * `allowedHosts` comes from project config and widens rule 2 only. It can never
 * re-enable a blocked scheme: `file://` stays refused even if someone puts `*`
 * in the list, because that entry is about *where* the browser may go, not
 * about turning it into a file reader.
 */
export function checkUrl(raw: string, allowedHosts: string[] = []): UrlVerdict {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { allowed: false, reason: 'A URL is required.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      allowed: false,
      // Relative URLs are a common model mistake and the fix is obvious, so say so.
      reason: `Not a valid absolute URL: ${trimmed}. Include the scheme, e.g. http://localhost:3000/.`,
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `Refused ${parsed.protocol} — the browser may only load http and https URLs.`,
    };
  }

  const host = parsed.hostname;
  if (isLoopbackHost(host)) return { allowed: true, url: parsed.toString() };

  for (const pattern of allowedHosts) {
    if (hostMatches(host, pattern)) return { allowed: true, url: parsed.toString() };
  }

  return {
    allowed: false,
    reason:
      `Refused ${host} — the browser is limited to this machine (localhost). `
      + 'Other hosts have to be listed in the project\'s browser.allow_hosts config.',
  };
}
