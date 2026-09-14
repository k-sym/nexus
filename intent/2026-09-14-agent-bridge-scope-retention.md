# Intent: Agent Bridge project scope and retention
Author: Keith. Status: draft. Source: issue #452 and 2026-09-14 conversation.

## Problem
Allowed bridge senders can address every project. SQLite inbox history grows without
a retention policy, and approved replies retry indefinitely after delivery failures.

## Proposed outcome
Opt projects into delivery, optionally restrict their threads, retain terminal inbox
history for 30 days by default, and expose exhausted replies for manual Retry or Discard.

## Affected users and systems
Keith; backend bridge, SQLite migrations, web Settings and Trust & Privacy. Deploy to
baker-pro after PR review. No iOS changes.

## Constraints
- Global sender, size, rate and hop checks remain in force; project scope only narrows access.
- Projects default off on upgrade; existing inbox and reply rows survive migration.
- Pending/running work and undelivered approved replies survive retention pruning.
- Retry retains the original reply ID; Discard records who and when without deleting the row.
- Scope changes and reply actions remain human UI operations, absent from agent tools.
- Preserve the user's existing iOS project-file edit.

## Open questions
Design defaults: scope controls in Settings → Agent Bridge; 30-day SQLite retention.
