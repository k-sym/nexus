import { execFileSync } from 'node:child_process';
import type { GitDiffFile, GitDiffHunk, GitDiffState, GitDiffSummary, Project, ReviewAction, ReviewActionResult, Task } from '@nexus/shared';

type ParsedDiff = {
  files: GitDiffFile[];
  hunks: GitDiffHunk[];
  added: number;
  deleted: number;
};

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitCommandResult {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    const raw = String(err?.stderr || err?.message || '').trim();
    const stderr = raw.includes('not a git repository') ? 'Not a git repository' : raw || 'git command failed';
    return { ok: false, stdout: '', stderr };
  }
}

function cleanStatusPath(raw: string): string {
  return raw.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function parseStatus(stdout: string) {
  const staged_files: string[] = [];
  const unstaged_files: string[] = [];
  const untracked_files: string[] = [];
  const parts = stdout.split('\0').filter(Boolean);

  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    const path = cleanStatusPath(entry.slice(3));

    if (xy.startsWith('??')) {
      untracked_files.push(path);
    } else if (xy[0] !== ' ' && xy[0] !== '?') {
      staged_files.push(path);
    } else if (xy[1] !== ' ' && xy[1] !== '?') {
      unstaged_files.push(path);
    }
  }

  return {
    staged_files: [...new Set(staged_files)].sort(),
    unstaged_files: [...new Set(unstaged_files)].sort(),
    untracked_files: [...new Set(untracked_files)].sort(),
  };
}

function parseHunkHeader(header: string) {
  const match = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return { old_start: null, new_start: null, old_lines: null, new_lines: null };

  return {
    old_start: Number(match[1]),
    new_start: Number(match[3]),
    old_lines: match[2] ? Number(match[2]) : null,
    new_lines: match[4] ? Number(match[4]) : null,
  };
}

function statusFromPaths(oldPath: string | null, newPath: string | null): GitDiffFile['status'] {
  if (oldPath && !newPath) return 'deleted';
  if (!oldPath && newPath) return 'added';
  if (oldPath && newPath && oldPath !== newPath) return 'renamed';
  return 'modified';
}

function parseOneDiff(output: string, staged: boolean): ParsedDiff {
  const files: GitDiffFile[] = [];
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffFile | null = null;
  let currentHunk: string[] = [];
  let currentHeader = '';
  let added = 0;
  let deleted = 0;

  const flushHunk = () => {
    if (!current || currentHunk.length === 0) return;

    const header = currentHeader || '@@ @@';
    const numbers = parseHunkHeader(header);
    const diff = currentHunk.join('\n');
    const hunkIndex = current.hunks.length;
    const oldStart = numbers.old_start == null ? '' : `-${numbers.old_start}`;
    const newStart = numbers.new_start == null ? '' : `+${numbers.new_start}`;
    const hunk: GitDiffHunk = {
      id: `${staged ? 'staged' : 'unstaged'}:${hunkIndex}:${current.path}:${oldStart}:${newStart}`,
      file: current.path,
      header,
      diff,
      prompt: `Review this change in ${current.path}${header !== '@@ @@' ? ` (${header})` : ''}:\n\n\`\`\`diff\n${diff}\n\`\`\``,
      staged,
      ...numbers,
    };

    current.hunks.push(hunk);
    hunks.push(hunk);
    currentHunk = [];
    currentHeader = '';
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushHunk();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match ? match[1] : null;
      const newPath = match ? match[2] : null;
      const path = newPath || oldPath || 'unknown';

      current = {
        path,
        old_path: oldPath,
        new_path: newPath,
        status: statusFromPaths(oldPath, newPath),
        added: 0,
        deleted: 0,
        staged,
        hunks: [],
      };
      files.push(current);
      continue;
    }

    if (!current) continue;

    if (line.startsWith('--- ')) {
      current.old_path = line.slice(4) !== '/dev/null' ? line.slice(4).replace(/^a\//, '') : current.old_path;
      current.status = statusFromPaths(current.old_path, current.new_path);
      continue;
    }

    if (line.startsWith('+++ ')) {
      current.new_path = line.slice(4) !== '/dev/null' ? line.slice(4).replace(/^b\//, '') : current.new_path;
      current.path = current.new_path || current.old_path || current.path;
      current.status = statusFromPaths(current.old_path, current.new_path);
      continue;
    }

    if (line.startsWith('@@ ')) {
      flushHunk();
      currentHeader = line;
      currentHunk.push(line);
      continue;
    }

    if (currentHunk.length > 0) {
      currentHunk.push(line);
      if (line.startsWith('+')) added += 1;
      if (line.startsWith('-')) deleted += 1;
      current.added += line.startsWith('+') ? 1 : 0;
      current.deleted += line.startsWith('-') ? 1 : 0;
    }
  }

  flushHunk();
  return { files, hunks, added, deleted };
}

export function parseGitDiff(output: string, staged: boolean): GitDiffHunk[] {
  return parseOneDiff(output, staged).hunks;
}

export function getProjectGitDiff(project: Pick<Project, 'id' | 'repo_path' | 'git_remote'>): GitDiffState {
  const repoPath = project.repo_path;
  if (!repoPath) {
    return { ok: false, reason: 'not_git_repo', message: 'Project repo_path is empty', repo_path: repoPath, git_remote: project.git_remote };
  }

  const repoCheck = runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!repoCheck.ok) {
    return {
      ok: false,
      reason: repoCheck.stderr === 'Not a git repository' ? 'not_git_repo' : 'git_error',
      message: repoCheck.stderr,
      repo_path: repoPath,
      git_remote: project.git_remote,
    };
  }

  const status = parseStatus(runGit(repoPath, ['status', '--porcelain=v1', '-z']).stdout);
  const stagedDiff = runGit(repoPath, ['diff', '--cached', '--no-ext-diff', '--unified=80']);
  const unstagedDiff = runGit(repoPath, ['diff', '--no-ext-diff', '--unified=80']);

  if (!stagedDiff.ok || !unstagedDiff.ok) {
    const failed = !stagedDiff.ok ? stagedDiff : unstagedDiff;
    return { ok: false, reason: 'git_error', message: failed.stderr, repo_path: repoPath, git_remote: project.git_remote };
  }

  const staged = parseOneDiff(stagedDiff.stdout, true);
  const unstaged = parseOneDiff(unstagedDiff.stdout, false);
  const files = [...staged.files, ...unstaged.files];
  const hunks = [...staged.hunks, ...unstaged.hunks];
  const summary: GitDiffSummary = {
    files: new Set(files.map((file) => file.path)).size,
    hunks: hunks.length,
    added: staged.added + unstaged.added,
    deleted: staged.deleted + unstaged.deleted,
    ...status,
  };

  return {
    ok: true,
    repo_path: repoPath,
    git_remote: project.git_remote,
    has_changes: summary.files > 0 || summary.untracked_files.length > 0,
    summary,
    files,
    hunks,
  };
}

function actionTitle(action: ReviewAction, hunk: GitDiffHunk) {
  if (action === 'ask_reviewer') return `Review hunk in ${hunk.file}`;
  if (action === 'explain_change') return `Explain hunk in ${hunk.file}`;
  if (action === 'spawn_fix_task') return `Fix hunk in ${hunk.file}`;
  if (action === 'assign_reviewer') return `Assign reviewer for ${hunk.file}`;
  return `Discuss hunk in ${hunk.file}`;
}

function actionDescription(project: Project, task: Task | null, action: ReviewAction, hunk: GitDiffHunk, note?: string) {
  const parts = [
    `Suggested persona/provider: ${action === 'spawn_fix_task' ? 'Developer / Claude Code' : 'Reviewer / Codex'}`,
    `Source task: ${task ? `${task.title} (${task.id})` : 'none'}`,
    `Project: ${project.name} (${project.id})`,
    `File: ${hunk.file}`,
    `Hunk: ${hunk.header}`,
    '',
    hunk.prompt,
  ];

  if (note?.trim()) parts.push('', `User note: ${note.trim()}`);
  return parts.join('\n');
}

export function buildReviewActionPrompt(project: Project, task: Task | null, action: ReviewAction, hunk: GitDiffHunk, note?: string) {
  return actionDescription(project, task, action, hunk, note);
}

export function reviewActionPlan(action: ReviewAction): { status: Task['status']; assigned_agent: string | null; model_key: string | null; createsTask: boolean } {
  if (action === 'spawn_fix_task') return { status: 'todo', assigned_agent: 'Developer', model_key: null, createsTask: true };
  if (action === 'assign_reviewer') return { status: 'review', assigned_agent: 'Reviewer', model_key: null, createsTask: false };
  return { status: 'review', assigned_agent: 'Reviewer', model_key: null, createsTask: true };
}

export function buildReviewActionTitle(action: ReviewAction, hunk: GitDiffHunk) {
  return actionTitle(action, hunk);
}
