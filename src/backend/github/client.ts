/**
 * Minimal GitHub REST client: fetch a repo's open issues, and create issues
 * for Idea Watcher graduation (#352). Reads work with an optional bearer token
 * from GITHUB_TOKEN (public repos need none); creating an issue requires one.
 * Mirrors the shape of the Jira client (typed error, injectable fetch).
 *
 * createIssue is the codebase's only GitHub write. It is reachable solely from
 * the confirm-gated graduation route — never expose it as an agent tool
 * without revisiting the tool-policy treatment (see #352).
 */
export class GitHubError extends Error {
  constructor(message: string, readonly status?: number, readonly bodySnippet?: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** The subset of an issue we use. PRs are excluded before this is returned. */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  /** Label names attached to the issue ([] when none). */
  labels: string[];
}

interface RawIssue extends Omit<GitHubIssue, 'labels'> {
  /** Raw GitHub labels: array of objects carrying a `name`. */
  labels?: Array<{ name: string }> | null;
  /** Present only on pull requests in the issues feed. */
  pull_request?: unknown;
}

const PER_PAGE = 100;
const MAX_PAGES = 5; // cap: up to 500 open issues per project sync

/**
 * Fetch a repo's open issues (PRs excluded), following pagination up to a cap.
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */
export async function fetchOpenIssues(
  ref: GitHubRepoRef,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubIssue[]> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'nexus',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const all: GitHubIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers });
    } catch (err) {
      throw new GitHubError(`GitHub request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
      throw new GitHubError(`GitHub ${ref.owner}/${ref.repo} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
    }
    const batch = (await res.json()) as RawIssue[];
    for (const raw of batch) {
      if (raw.pull_request) continue; // the issues feed includes PRs; drop them
      all.push({
        number: raw.number,
        title: raw.title,
        body: raw.body ?? null,
        html_url: raw.html_url,
        labels: raw.labels?.map((l) => l.name) ?? [],
      });
    }
    if (batch.length < PER_PAGE) break; // last page reached
  }
  return all;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels?: string[];
}

/** The subset of a created issue the graduation flow records. */
export interface CreatedIssue {
  number: number;
  html_url: string;
}

/** Create an issue. Requires a token — GitHub rejects anonymous writes. */
export async function createIssue(
  ref: GitHubRepoRef,
  input: CreateIssueInput,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedIssue> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'nexus',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        ...(input.labels?.length ? { labels: input.labels } : {}),
      }),
    });
  } catch (err) {
    throw new GitHubError(`GitHub request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new GitHubError(`GitHub ${ref.owner}/${ref.repo} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
  }
  const raw = (await res.json()) as { number: number; html_url: string };
  return { number: raw.number, html_url: raw.html_url };
}
