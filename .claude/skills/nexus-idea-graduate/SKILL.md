---
name: nexus-idea-graduate
description: Draft the detailed GitHub issue set that graduates a Nexus idea out of its thread, each issue in intent shape with acceptance criteria and cross-links, ready to paste into the Graduate dialog. Use when a message asks to "draft a detailed GitHub issue set", when Keith says "graduate this", "draft the issues", "turn this into issues", or asks how to split an idea into work.
---

# Idea graduation

Graduating an idea files the codebase's only GitHub write, and it happens only after Keith edits and confirms each issue in the Graduate dialog. This skill produces the drafts the dialog receives. Keith's bar is that an issue is detailed enough for an agent to pick up cold: the evening-triage routine turns issues into agent-ready specs, and the night queue builds from them, so an under-specified issue costs a night.

## Steps

1. **Read the whole thread** and the seed notes. Findings that Keith discarded in the dialogue stay out; ones he kept become constraints or context.
2. **Decide the split.** One issue when the work ships as one PR. Several when the parts are independently shippable, a surface differs (web, iOS, glasses, backend), or a removal precedes a feature. Order them so the first issue is the one the others depend on; the backend appends "Part of #first" to the rest when they are filed.
3. **Draft each issue** in the shape below. The body's first four sections are the intent file shape, so a filed issue can be copied straight into `intent/` when the work starts and `sdlc-spec` can read it without translation.
4. **Propose labels** from the target repo's existing set (`gh label list --repo owner/repo`); k-sym/nexus carries only GitHub's defaults, so `enhancement` or `bug` is usually the whole answer there. `night-queue` marks agent-ready work only on repos that have the label and the evening-triage routine. New labels are Keith's call.
5. **Return the drafts as one block per issue** so they can be pasted into the dialog's title, body, and labels fields. No prose between them beyond a one-line note on the split.

## Issue shape

```markdown
Title: <verb phrase, under 70 characters>
Labels: <comma-separated>

## Problem
What cannot be done today, and the evidence from the thread.

## Proposed outcome
The end state in one or two sentences.

## Affected users and systems
Surfaces, routes, tables, config keys, the deploy host.

## Constraints
What must not change and why, including Nexus policy that applies (confirm-gated external writes, tombstone tables, thin-client gating).

## Approach
The design sketch from the dialogue: schema, routes, UI, in the order they would be built. Enough for an agent to start; decisions still open go under Open questions, not here.

## Acceptance criteria
- [ ] Each testable in one sentence.

## Test notes
Which suites cover it, what needs a manual check, whether iOS needs a simulator build.

## Open questions
- Each as a question Keith can answer in one line.

Related: <other issues in the set, by working title until numbers exist>
```

An issue body runs 40 to 120 lines. Shorter than that usually means the dialogue has not settled the approach; say so and ask the one question that would settle it instead of drafting thin.
