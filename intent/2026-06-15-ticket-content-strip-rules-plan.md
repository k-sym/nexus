# Ticket content strip rules - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user maintain a global list of text chunks ("strip rules") that are removed from every Jira ticket body during cleaning - whitespace-/case-tolerant literal matching, with `***` as a wildcard for per-ticket variable fragments.

**Architecture:** A new pure `applyContentRules(text, rules)` in `cleanAdf.ts` runs between `adfToText` and the existing heuristic `trimBoilerplate`. Rules live in `jira.content_rules: string[]` in `~/.nexus/config.yaml`; the description route loads them and threads them into `cleanAdf`. Cleaning happens on read (raw ADF is cached, cleaned output isn't), so rule edits take effect on the next ticket opened - no re-fetch, no DB migration. Managed in the Settings page under the Jira section.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React + Tailwind. Backend tests: `node:test` via `tsx --test` in `src/backend/test/`. Frontend tests: vitest.

**Branch:** continue on `feat/tickets-preview-braindump` (this extends the `cleanAdf` work in PR #69, which is not yet merged - stacking a new PR on an unmerged base is avoided).

---

## File structure

- `src/shared/index.ts` - MODIFY. Add `content_rules: string[]` to the `jira` config interface.
- `src/backend/config.ts` - MODIFY. Default `jira.content_rules: []` in `DEFAULT_CONFIG`.
- `src/backend/tickets/cleanAdf.ts` - MODIFY. Add `applyContentRules`; extend `cleanAdf` signature.
- `src/backend/routes/tickets.ts` - MODIFY. Load `config.jira.content_rules`, pass to `cleanAdf`.
- `src/frontend/src/components/SettingsPage.tsx` - MODIFY. "Content strip rules" editor under Jira.
- `src/backend/test/clean-adf.test.ts` - MODIFY (append). Tests for `applyContentRules` + `cleanAdf` rules.

---

## Task 1: Config field - shared type + default

**Files:**
- Modify: `src/shared/index.ts` (the `jira` block of `NexusConfig`, ~lines 99-110)
- Modify: `src/backend/config.ts` (`DEFAULT_CONFIG.jira`, ~lines 43-49)

- [ ] **Step 1: Add the field to the shared interface**

In `src/shared/index.ts`, in the `jira` object of `NexusConfig`, replace the existing `poll_minutes` line so the new field sits directly after it inside the same `jira: { ... }` block:

```typescript
    /** Poll cadence in minutes while Nexus is running. */
    poll_minutes: number;
    /** User-maintained chunks stripped from every ticket body during cleaning.
     *  Whitespace/case-tolerant literal match; three asterisks match any text. */
    content_rules: string[];
```

- [ ] **Step 2: Add the default**

In `src/backend/config.ts`, in `DEFAULT_CONFIG.jira`, replace the `poll_minutes: 15,` line with:

```typescript
    poll_minutes: 15,
    content_rules: [],
```

> Back-compat is automatic: `loadConfig` deep-merges parsed YAML over `DEFAULT_CONFIG`, and `deepMerge` keeps the base value when the parsed config lacks a key - so older `config.yaml` files (without `content_rules`) load as `[]` rather than `undefined`.

- [ ] **Step 3: Typecheck**

Run: `npm run --workspace=src/shared build && npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/index.ts src/backend/config.ts
git commit -m "feat(jira): add content_rules config field (default [])"
```

---

## Task 2: `applyContentRules` (the matcher)

**Files:**
- Modify: `src/backend/tickets/cleanAdf.ts`
- Test: `src/backend/test/clean-adf.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `src/backend/test/clean-adf.test.ts`:

```typescript
import { applyContentRules } from '../tickets/cleanAdf';

const HILL = 'Hill Holdings Ltd - email disclaimer*\nThis e-mail and any files distributed with it are intended solely for the individual or organisation to whom it is addressed.|';

test('applyContentRules strips a static pasted chunk verbatim', () => {
  const body = `Please action this.\n\n${HILL}`;
  assert.equal(applyContentRules(body, [HILL]), 'Please action this.');
});

test('applyContentRules matches despite different whitespace/wrapping', () => {
  const reflowed = HILL.replace(/ /g, '\n'); // every space became a newline
  const body = `Top.\n\n${reflowed}`;
  assert.equal(applyContentRules(body, [HILL]), 'Top.');
});

test('applyContentRules matches case-insensitively', () => {
  const body = 'Body.\n\nCONFIDENTIAL: do not forward.';
  assert.equal(applyContentRules(body, ['confidential: do not forward.']), 'Body.');
});

test('applyContentRules wildcard strips a block whose middle varies', () => {
  const rule = 'Reply above this line.\n***\nCGBANNERINDICATOR';
  const t1 = 'Real one.\n\nReply above this line.\n https://x.test/u/AAAA-TOKEN-1\nCGBANNERINDICATOR';
  const t2 = 'Real two.\n\nReply above this line.\n https://x.test/u/BBBB-TOKEN-2\nCGBANNERINDICATOR';
  assert.equal(applyContentRules(t1, [rule]), 'Real one.');
  assert.equal(applyContentRules(t2, [rule]), 'Real two.');
});

test('applyContentRules applies multiple independent rules', () => {
  const body = 'Keep this.\n\nSent from my iPhone\n\nKeep that too.\n\nGet Outlook for iOS';
  const out = applyContentRules(body, ['Sent from my iPhone', 'Get Outlook for iOS']);
  assert.equal(out, 'Keep this.\n\nKeep that too.');
});

test('applyContentRules ignores empty / whitespace-only rules', () => {
  const body = 'Untouched body.';
  assert.equal(applyContentRules(body, ['', '   ', '\n']), 'Untouched body.');
});

test('applyContentRules collapses blank lines left behind', () => {
  const body = 'A.\n\nREMOVE ME\n\nB.';
  assert.equal(applyContentRules(body, ['REMOVE ME']), 'A.\n\nB.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: FAIL - `applyContentRules` not exported.

- [ ] **Step 3: Implement `applyContentRules`**

Append to `src/backend/tickets/cleanAdf.ts`:

```typescript
/**
 * Build a matcher for a single strip rule: whitespace-tolerant, case-insensitive
 * literal match, with three asterisks standing in for any run of text (non-greedy)
 * so a pasted chunk still matches when a per-ticket fragment (e.g. a tracking URL)
 * varies between tickets.
 *
 * Split on the literal `***` FIRST, then escape + whitespace-relax each segment,
 * then join with a non-greedy wildcard. No sentinel substitution, so nothing in
 * the rule text can collide with it.
 */
function ruleToRegex(rule: string): RegExp {
  const source = rule.trim()
    .split('***')
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('[\\s\\S]*?');
  return new RegExp(source, 'gi');
}

/**
 * Remove every user-defined strip rule from `text`. Rules are applied in order;
 * empty/whitespace-only rules are skipped. Blank lines left behind are collapsed.
 */
export function applyContentRules(text: string, rules: string[]): string {
  let out = text;
  for (const rule of rules) {
    if (!rule || !rule.trim()) continue;
    out = out.replace(ruleToRegex(rule), '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: PASS (prior 9 + 7 new = 16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/tickets/cleanAdf.ts src/backend/test/clean-adf.test.ts
git commit -m "feat(tickets): applyContentRules - user-defined strip rules with wildcard"
```

---

## Task 3: Thread rules through `cleanAdf`

**Files:**
- Modify: `src/backend/tickets/cleanAdf.ts`
- Test: `src/backend/test/clean-adf.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/backend/test/clean-adf.test.ts`:

```typescript
test('cleanAdf applies content rules before the heuristic trim', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Real body.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'CONFIDENTIAL NOTICE: do not forward.' }] },
    ],
  };
  const result = cleanAdf(doc, ['CONFIDENTIAL NOTICE: do not forward.']);
  assert.equal(result.body, 'Real body.');
});

test('cleanAdf with no rules behaves as before', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello.' }] }] };
  assert.equal(cleanAdf(doc).body, 'Hello.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: FAIL - `cleanAdf` currently takes one argument; the rules arg is ignored, so the first new test fails (body still contains the confidential line).

- [ ] **Step 3: Extend the `cleanAdf` signature**

In `src/backend/tickets/cleanAdf.ts`, replace the existing `cleanAdf`:

```typescript
/** Fetch-to-display pipeline: raw ADF -> cleaned, trimmed plain text. */
export function cleanAdf(doc: AdfNode | null | undefined): CleanedBody {
  return trimBoilerplate(adfToText(doc));
}
```

with:

```typescript
/** Fetch-to-display pipeline: raw ADF -> user strip rules -> heuristic trim -> cleaned text. */
export function cleanAdf(doc: AdfNode | null | undefined, rules: string[] = []): CleanedBody {
  return trimBoilerplate(applyContentRules(adfToText(doc), rules));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/tickets/cleanAdf.ts src/backend/test/clean-adf.test.ts
git commit -m "feat(tickets): thread content rules through cleanAdf"
```

---

## Task 4: Wire rules into the description route

**Files:**
- Modify: `src/backend/routes/tickets.ts`

The route already imports `cleanAdf` and `loadConfig`. Hoist the config load above `respond` so the cache-hit path also has the rules, pass `rules` into `cleanAdf`, and drop the now-redundant second `loadConfig()`.

- [ ] **Step 1: Apply the edit**

In `src/backend/routes/tickets.ts`, replace this block:

```typescript
    const respond = (adfJson: string | null, fetchedAt: string | null) => {
      if (!adfJson) return { key, body: '', trimmed: [], fetchedAt, empty: true };
      let adf: AdfNode | null = null;
      try { adf = JSON.parse(adfJson) as AdfNode; } catch { adf = null; }
      const cleaned = cleanAdf(adf);
      return { key, body: cleaned.body, trimmed: cleaned.trimmed, fetchedAt, empty: cleaned.body.length === 0 };
    };

    if (row.description_adf && !refresh) {
      return respond(row.description_adf, row.description_fetched_at);
    }

    const config = loadConfig();
    const token = process.env.JIRA_TOKEN;
```

with:

```typescript
    const config = loadConfig();
    const rules = config.jira.content_rules ?? [];

    const respond = (adfJson: string | null, fetchedAt: string | null) => {
      if (!adfJson) return { key, body: '', trimmed: [], fetchedAt, empty: true };
      let adf: AdfNode | null = null;
      try { adf = JSON.parse(adfJson) as AdfNode; } catch { adf = null; }
      const cleaned = cleanAdf(adf, rules);
      return { key, body: cleaned.body, trimmed: cleaned.trimmed, fetchedAt, empty: cleaned.body.length === 0 };
    };

    if (row.description_adf && !refresh) {
      return respond(row.description_adf, row.description_fetched_at);
    }

    const token = process.env.JIRA_TOKEN;
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 3: Existing route tests still pass**

Run: `cd src/backend && npx tsx --test test/tickets-description-route.test.ts`
Expected: PASS (3 tests - they use no rules, so behaviour is unchanged; this confirms the refactor didn't break the cache-hit / unconfigured / 404 paths).

> Rule-application correctness is covered by the `cleanAdf` / `applyContentRules` unit tests (Tasks 2-3). We do NOT add a route test that writes `content_rules`, because `saveConfig` writes the real `~/.nexus/config.yaml`; the route is a thin pass-through of config -> `cleanAdf`.

- [ ] **Step 4: Commit**

```bash
git add src/backend/routes/tickets.ts
git commit -m "feat(tickets): apply configured content rules in the description route"
```

---

## Task 5: Settings UI - content strip rules editor

**Files:**
- Modify: `src/frontend/src/components/SettingsPage.tsx`

Add a "Content strip rules" `Field` to the Jira `Section`, after the "Poll interval (minutes)" field and before the closing `<p>` token note.

- [ ] **Step 1: Add the editor**

In `src/frontend/src/components/SettingsPage.tsx`, immediately after the closing `</Field>` of the "Poll interval (minutes)" field, insert:

```tsx
            <Field label="Content strip rules">
              <div className="space-y-2">
                {((config.jira.content_rules ?? []) as string[]).map((rule: string, i: number) => (
                  <div key={i} className="flex gap-2">
                    <textarea
                      value={rule}
                      onChange={(e) => {
                        const next = [...((config.jira.content_rules ?? []) as string[])];
                        next[i] = e.target.value;
                        update(['jira', 'content_rules'], next);
                      }}
                      rows={3}
                      placeholder="Paste a footer chunk to strip from every ticket..."
                      className="flex-1 surface-panel border border-subtle rounded px-2 py-1 text-sm text-primary font-mono resize-y"
                    />
                    <button
                      onClick={() => {
                        const next = ((config.jira.content_rules ?? []) as string[]).filter((_: string, j: number) => j !== i);
                        update(['jira', 'content_rules'], next);
                      }}
                      title="Remove rule"
                      className="shrink-0 px-2 py-1 text-xs surface-elevated text-faint hover:text-red-400 rounded transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => update(['jira', 'content_rules'], [...((config.jira.content_rules ?? []) as string[]), ''])}
                  className="px-3 py-1 text-xs surface-elevated text-faint hover:text-primary rounded transition-colors"
                >
                  + Add rule
                </button>
                <p className="text-[10px] text-faint">
                  Pasted text is removed from every ticket preview (ignores whitespace and case). Use{' '}
                  <span className="font-mono text-muted">***</span> for parts that vary between tickets, e.g. a tracking URL.
                </p>
              </div>
            </Field>
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Existing SettingsPage tests still pass**

Run: `npm run --workspace=src/frontend test -- SettingsPage`
Expected: PASS (the existing suite - the editor is additive and `content_rules` defaults to `[]`, so nothing prior breaks).

> No new unit test for this presentational editor: the risky logic (matching) is fully unit-tested at the `applyContentRules` level. The editor is verified by typecheck, the existing SettingsPage suite, and the manual smoke in Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/SettingsPage.tsx
git commit -m "feat(settings): content strip rules editor under Jira"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `cd src/backend && npm test`
Expected: PASS (all suites, including the expanded `clean-adf` suite - 18 tests there).

- [ ] **Step 2: Frontend tests**

Run: `npm run --workspace=src/frontend test`
Expected: PASS except the pre-existing `theme.test.ts` starfield failure (unrelated; fails on `main` too).

- [ ] **Step 3: Repo typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke (dev server)**

Run `npm run dev` (or `npm run web`), then:
1. Settings -> Jira -> Content strip rules -> "+ Add rule" -> paste a known footer (e.g. the Hill disclaimer). Save.
2. Open a ticket that contains that footer -> confirm the preview strip no longer shows it.
3. For a footer with a varying URL (Mimecast "Reply above this line"), paste it with `***` replacing the URL -> save -> confirm it's stripped on more than one such ticket.

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore: content strip rules verification cleanup"
```

---

## Self-review notes

- **Spec coverage:** matching algorithm -> Task 2 (prototype-validated, sentinel-free split-on-`***`); silent removal -> inherent in `applyContentRules` (removed, not added to `trimmed`); pipeline order `adfToText -> applyContentRules -> trimBoilerplate` -> Task 3; storage `jira.content_rules` -> Task 1; route threading -> Task 4; Settings UI -> Task 5; back-compat default `[]` -> Task 1 (via `deepMerge`).
- **Deviation from spec:** the spec's "Settings round-trip test" is intentionally omitted - `saveConfig` writes the real `~/.nexus/config.yaml`, so an automated PUT test would clobber the user's config. The route passes `incoming.jira` through wholesale and returns the merged result (verified in `routes/settings.ts`), so `content_rules` round-trips; covered by manual smoke (Task 6).
- **Type consistency:** `content_rules: string[]` is named identically across the shared interface (Task 1), `applyContentRules(text, rules: string[])` (Task 2), `cleanAdf(doc, rules: string[] = [])` (Task 3), the route's `config.jira.content_rules ?? []` (Task 4), and the Settings editor (Task 5).
- **Placeholder scan:** none.
- **Matcher note:** the `***` wildcard splits the rule on the literal `***` and joins escaped segments with `[\s\S]*?` - no sentinel substitution, verified against a "WC1V postcode" collision case during planning.
