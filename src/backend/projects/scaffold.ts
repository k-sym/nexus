/**
 * Make a newly-linked project agent-aware on disk (#274 follow-up).
 *
 * The orientation block (pi/orientation.ts) tells the agent that this project
 * keeps its thinking under `project_docs/` and that per-project conventions live
 * in `AGENTS.md`. This scaffolds both so those pointers land somewhere real:
 *
 *   - the `project_docs/` skeleton, aligned with what the block names
 *     (`specs`, `plans`, `design`) plus `uploads` for chat drops
 *   - a short `project_docs/README.md` explaining the folders, for humans
 *   - a minimal `AGENTS.md` stub — which Pi auto-loads into every session — so a
 *     fresh project starts with a place for its house rules
 *
 * This is the in-app realization of the "GitHub template" idea: Nexus scaffolds
 * the convention rather than relying on a separate template repo.
 *
 * Every write is idempotent and non-destructive: existing directories are left
 * alone, and an existing `AGENTS.md`/`CLAUDE.md` is NEVER overwritten — linking
 * a repo that already has agent instructions must not clobber them.
 */
import fsDefault from 'node:fs';
import path from 'node:path';

/** Subdirectories created under `project_docs/`. `design` matches the
 *  orientation block; `uploads` is where chat file drops land. */
export const PROJECT_DOCS_DIRS = ['specs', 'plans', 'design', 'uploads'] as const;

/** Agent-instruction filenames Pi already loads. If any exists we don't add
 *  our own — the project already has conventions. */
const AGENTS_FILE_CANDIDATES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

type FsLike = Pick<typeof fsDefault, 'existsSync' | 'mkdirSync' | 'writeFileSync'>;

export interface ScaffoldResult {
  /** Subdirectory names created this call (absent ones only). */
  createdDirs: string[];
  /** Whether an AGENTS.md stub was written (false when one already existed). */
  wroteAgentsFile: boolean;
  /** Whether the project_docs/README.md was written. */
  wroteDocsReadme: boolean;
}

function docsReadme(): string {
  return [
    '# project_docs',
    '',
    'Where this project keeps its own thinking. Nexus points agents here, and the',
    'agent writes specs and plans here rather than only in chat.',
    '',
    '- `specs/` — feature specs and PRDs',
    '- `plans/` — implementation plans',
    '- `design/` — design notes and decisions',
    '- `uploads/` — files dropped into a chat session',
    '',
  ].join('\n');
}

function agentsStub(projectName: string): string {
  const title = projectName.trim() || 'this project';
  return [
    `# ${title} — agent notes`,
    '',
    '<!-- Nexus created this as a starting point. Pi loads it into every agent',
    '     session for this repo, so keep it short and current. Delete this',
    '     comment once you have filled it in. -->',
    '',
    '## Where things live',
    '',
    '- `project_docs/specs/` — feature specs and PRDs',
    '- `project_docs/plans/` — implementation plans',
    '- `project_docs/design/` — design notes and decisions',
    '',
    '## Conventions',
    '',
    '<!-- House rules the agent should follow: how to run and test this project,',
    '     what to avoid, where things go. The agent reads this every session. -->',
    '',
  ].join('\n');
}

/** True when the repo already carries an agent-instructions file. */
function hasAgentsFile(repoPath: string, fs: FsLike): boolean {
  return AGENTS_FILE_CANDIDATES.some((name) => fs.existsSync(path.join(repoPath, name)));
}

/**
 * Scaffold a project's docs skeleton and agent files. Safe to call repeatedly —
 * it only creates what's missing and never overwrites an existing agents file.
 * Best-effort by contract: the caller treats a throw as non-fatal (a project
 * must still be created even if its repo dir is read-only).
 */
export function scaffoldProjectDocs(
  repoPath: string,
  projectName = '',
  fs: FsLike = fsDefault,
): ScaffoldResult {
  const docsDir = path.join(repoPath, 'project_docs');
  const createdDirs: string[] = [];

  for (const sub of PROJECT_DOCS_DIRS) {
    const dir = path.join(docsDir, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDirs.push(sub);
    }
  }

  let wroteDocsReadme = false;
  const readmePath = path.join(docsDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, docsReadme());
    wroteDocsReadme = true;
  }

  let wroteAgentsFile = false;
  // Only when the repo has no agent-instructions file at all — never clobber
  // conventions the project already brought with it.
  if (!hasAgentsFile(repoPath, fs)) {
    fs.writeFileSync(path.join(repoPath, 'AGENTS.md'), agentsStub(projectName));
    wroteAgentsFile = true;
  }

  return { createdDirs, wroteAgentsFile, wroteDocsReadme };
}
