/**
 * Minimal Jira Cloud REST client for the native ticket poll. Mirrors what the
 * legacy jira-sync.sh curl did. Auth is HTTP Basic (account email : API token);
 * the token comes from the JIRA_TOKEN env var, never config/DB.
 */
import type { IncomingTicket } from '../tickets/sync.js';

export class JiraError extends Error {
  constructor(message: string, readonly status?: number, readonly bodySnippet?: string) {
    super(message);
    this.name = 'JiraError';
  }
}

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    priority?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    created?: string;
    updated?: string;
  };
}

export interface JiraQueryConfig {
  user: string;
  instance: string;
  project: string;
}

/** Normalise a configured instance to a bare host: tolerate a pasted
 *  `https://host`, a trailing slash, or surrounding whitespace so the request
 *  URL never becomes `https://https://…`. */
export function normalizeInstance(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Pure mapping: Jira issues → ticket rows. */
export function mapIssues(issues: JiraIssue[], instance: string): IncomingTicket[] {
  return issues.map((issue) => {
    const f = issue.fields ?? {};
    return {
      key: issue.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? '',
      priority: f.priority?.name ?? 'Medium',
      assignee: f.assignee?.displayName ?? null,
      created: f.created ? f.created.slice(0, 10) : null,
      updated: f.updated ? f.updated.slice(0, 10) : null,
      url: `https://${instance}/browse/${issue.key}`,
    };
  });
}

/**
 * Fetch open project tickets assigned to the authenticated user. `fetchImpl` is
 * injectable for tests; defaults to global fetch.
 */
export async function fetchJiraTickets(
  cfg: JiraQueryConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IncomingTicket[]> {
  const instance = normalizeInstance(cfg.instance);
  const url = `https://${instance}/rest/api/3/search/jql`;
  const jql = `project=${cfg.project} AND statusCategory != Done AND assignee = currentUser() ORDER BY created DESC`;
  const auth = Buffer.from(`${cfg.user}:${token}`).toString('base64');

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jql,
        maxResults: 100,
        fields: ['summary', 'status', 'priority', 'assignee', 'created', 'updated'],
      }),
    });
  } catch (err) {
    throw new JiraError(`Jira request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new JiraError(`Jira ${cfg.instance} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
  }

  const json = (await res.json()) as { issues?: JiraIssue[] };
  return mapIssues(json.issues ?? [], instance);
}

/**
 * Fetch a single issue's description (raw ADF). Returns null when the issue has
 * no description. `fetchImpl` is injectable for tests.
 */
export async function fetchJiraIssueDescription(
  cfg: JiraQueryConfig,
  token: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  const instance = normalizeInstance(cfg.instance);
  const url = `https://${instance}/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`;
  const auth = Buffer.from(`${cfg.user}:${token}`).toString('base64');

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new JiraError(`Jira request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new JiraError(`Jira ${cfg.instance} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
  }
  const json = (await res.json()) as { fields?: { description?: unknown } };
  return json.fields?.description ?? null;
}
