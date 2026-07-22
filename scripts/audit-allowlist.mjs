#!/usr/bin/env node
/**
 * `npm audit` with a time-boxed allowlist.
 *
 * Plain `npm audit --audit-level=moderate` cannot pass while a dependency we do not
 * control ships a vulnerable transitive pin, which leaves CI permanently red — and a
 * check that is always red is a check nobody reads. This wraps the audit so a known,
 * genuinely unfixable advisory can be accepted DELIBERATELY, in writing, with a date
 * attached, instead of the whole gate being switched off.
 *
 * It fails on:
 *   - any advisory at or above the severity threshold that is not allowlisted;
 *   - an allowlist entry whose `expires` date has passed (the exception has to be
 *     re-argued rather than quietly becoming permanent);
 *   - an allowlist entry that no longer matches anything (upstream fixed it, so the
 *     entry is now a lie — delete it).
 *
 * Usage:  node scripts/audit-allowlist.mjs [directory] [--level=moderate]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = join(ROOT, '.audit-allowlist.json');

const args = process.argv.slice(2);
const dir = resolve(ROOT, args.find((a) => !a.startsWith('--')) ?? '.');
const level = (args.find((a) => a.startsWith('--level=')) ?? '--level=moderate').split('=')[1];

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const threshold = RANK[level] ?? RANK.moderate;

/** `npm audit` exits non-zero when it finds anything, so read stdout regardless. */
function runAudit(cwd) {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

/** Flatten npm's nested report into one row per (advisory, package). */
function findings(report) {
  const out = [];
  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop(); // the GHSA identifier
      out.push({ id, pkg, severity: via.severity ?? v.severity, title: via.title ?? '', url: via.url });
    }
  }
  // npm repeats an advisory once per affected path; one row each is enough to judge.
  return [...new Map(out.map((f) => [`${f.id}:${f.pkg}`, f])).values()];
}

const report = runAudit(dir);
const relevant = findings(report).filter((f) => (RANK[f.severity] ?? 0) >= threshold);

const where = dir === ROOT ? '.' : dir.slice(ROOT.length + 1);
const today = new Date().toISOString().slice(0, 10);

// Entries are scoped to a directory: each audited package has its own dependency tree,
// so an exception for the workspace root must not silently apply to src/glasses — nor
// look "stale" when the glasses audit runs and never reports it.
const allEntries = existsSync(ALLOWLIST_PATH) ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).allow ?? [] : [];
const allowlist = allEntries.filter((a) => a.directory === where);

const problems = [];
const accepted = [];

for (const f of relevant) {
  const entry = allowlist.find((a) => a.id === f.id && a.package === f.pkg);
  if (!entry) {
    problems.push(`NOT ALLOWLISTED  ${f.severity.padEnd(8)} ${f.pkg} — ${f.title}\n                 ${f.url}`);
  } else if (entry.expires < today) {
    problems.push(
      `EXPIRED          ${f.pkg} — the exception lapsed on ${entry.expires}.\n` +
      `                 Re-check upstream, then either fix it or extend the date with a fresh reason.\n` +
      `                 ${f.url}`,
    );
  } else {
    accepted.push(`accepted until ${entry.expires}  ${f.severity.padEnd(8)} ${f.pkg} — ${entry.reason}`);
  }
}

// An entry that matches nothing is stale: upstream shipped a fix and the allowlist is
// now claiming a risk that no longer exists. Fail so it gets deleted.
for (const a of allowlist) {
  const stillApplies = relevant.some((f) => f.id === a.id && f.pkg === a.package);
  if (!stillApplies) {
    problems.push(
      `STALE ENTRY      ${a.package} (${a.id}) is allowlisted but no longer reported.\n` +
      `                 Upstream fixed it — delete the entry from .audit-allowlist.json.`,
    );
  }
}

console.log(`[audit] ${where} — ${relevant.length} advisory(ies) at or above ${level}`);
for (const line of accepted) console.log(`[audit]   ${line}`);

if (problems.length) {
  console.error(`\n[audit] FAILED in ${where}:\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

console.log(`[audit] ${where} OK`);
