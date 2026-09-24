# Model-selectable Nexus roles
Date: 2026-09-15
Status: accepted — Keith approved implementation 2026-09-15
Issue: https://github.com/k-sym/nexus/issues/454

Give Nexus threads five explicit child roles (Scout, Researcher, Builder, Refuter, Debugger), with human-selected models from either registered engine. Reduce parent-model work and permit independent review without changing the workflow.

Preserve project ownership, approvals and audit transcripts. Children run sequentially in the same working tree, cannot delegate, and stop with the parent or their configured ceilings. Persist per-thread model overrides and expose choices on web and iOS. No new external-write tools. Rich nested Activity rendering follows in #455.

Design: project_docs/specs/2026-09-15-model-selectable-roles.md
