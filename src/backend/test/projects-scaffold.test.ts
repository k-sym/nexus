import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scaffoldProjectDocs, PROJECT_DOCS_DIRS } from '../projects/scaffold';

function tempRepo(): { repo: string; cleanup: () => void } {
  const repo = fs.mkdtempSync(path.join(tmpdir(), 'nexus-scaffold-'));
  return { repo, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

const read = (repo: string, ...p: string[]) => fs.readFileSync(path.join(repo, ...p), 'utf8');
const exists = (repo: string, ...p: string[]) => fs.existsSync(path.join(repo, ...p));

test('scaffolds the full project_docs skeleton, its README, and an AGENTS.md', () => {
  const { repo, cleanup } = tempRepo();
  try {
    const result = scaffoldProjectDocs(repo, 'My Project');

    for (const sub of PROJECT_DOCS_DIRS) {
      assert.ok(exists(repo, 'project_docs', sub), `project_docs/${sub} created`);
    }
    // design/ is what the orientation block points at — it must be scaffolded.
    assert.ok(PROJECT_DOCS_DIRS.includes('design'));
    assert.ok(exists(repo, 'project_docs', 'README.md'));
    assert.ok(exists(repo, 'AGENTS.md'));

    assert.deepEqual(result.createdDirs.sort(), [...PROJECT_DOCS_DIRS].sort());
    assert.equal(result.wroteAgentsFile, true);
    assert.equal(result.wroteDocsReadme, true);

    // The AGENTS.md carries the project name and points at project_docs.
    const agents = read(repo, 'AGENTS.md');
    assert.match(agents, /My Project — agent notes/);
    assert.match(agents, /project_docs\/specs/);
  } finally {
    cleanup();
  }
});

test('is idempotent — a second call creates nothing and preserves content', () => {
  const { repo, cleanup } = tempRepo();
  try {
    scaffoldProjectDocs(repo, 'P');
    // A human edits the seeded AGENTS.md.
    const editedPath = path.join(repo, 'AGENTS.md');
    fs.writeFileSync(editedPath, '# edited by a human\n');

    const second = scaffoldProjectDocs(repo, 'P');
    assert.deepEqual(second.createdDirs, [], 'no dirs recreated');
    assert.equal(second.wroteAgentsFile, false, 'existing AGENTS.md left alone');
    assert.equal(second.wroteDocsReadme, false, 'existing README left alone');
    assert.equal(read(repo, 'AGENTS.md'), '# edited by a human\n', 'the human edit survives');
  } finally {
    cleanup();
  }
});

test('never overwrites an AGENTS.md the repo already had', () => {
  const { repo, cleanup } = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# existing conventions\n');
    const result = scaffoldProjectDocs(repo, 'P');

    assert.equal(result.wroteAgentsFile, false);
    assert.equal(read(repo, 'AGENTS.md'), '# existing conventions\n', 'the repo\'s own file is untouched');
    // The docs skeleton still gets created around it.
    assert.ok(exists(repo, 'project_docs', 'design'));
  } finally {
    cleanup();
  }
});

test('treats an existing CLAUDE.md as agent instructions and adds no AGENTS.md', () => {
  const { repo, cleanup } = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# claude conventions\n');
    const result = scaffoldProjectDocs(repo, 'P');

    // Pi loads CLAUDE.md too, so a second agents file would be redundant/confusing.
    assert.equal(result.wroteAgentsFile, false);
    assert.equal(exists(repo, 'AGENTS.md'), false, 'no competing AGENTS.md written');
  } finally {
    cleanup();
  }
});

test('fills in a generic title when the project has no name', () => {
  const { repo, cleanup } = tempRepo();
  try {
    scaffoldProjectDocs(repo, '   ');
    assert.match(read(repo, 'AGENTS.md'), /this project — agent notes/);
  } finally {
    cleanup();
  }
});

test('preserves a partial docs skeleton — only fills the gaps', () => {
  const { repo, cleanup } = tempRepo();
  try {
    // The repo already has specs/ with a real file in it.
    fs.mkdirSync(path.join(repo, 'project_docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'project_docs', 'specs', 'keep.md'), 'important');

    const result = scaffoldProjectDocs(repo, 'P');
    assert.equal(result.createdDirs.includes('specs'), false, 'existing specs/ not recreated');
    assert.ok(result.createdDirs.includes('design'), 'missing design/ filled in');
    assert.equal(read(repo, 'project_docs', 'specs', 'keep.md'), 'important', 'existing content preserved');
  } finally {
    cleanup();
  }
});
