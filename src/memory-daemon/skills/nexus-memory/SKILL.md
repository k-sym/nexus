---
name: nexus-memory
description: Recall this project's stored memories (decisions, context, conventions) before acting.
when_to_use: At the start of a task, or whenever prior project context would inform a decision.
---

# Nexus project memory

This project has a shared memory of prior decisions, conventions, and context, exposed through the
`memory_recall` tool (from the `nexus-memory` MCP server).

**At the start of a task**, call `memory_recall` with a short description of what you're about to do,
to ground yourself in relevant prior decisions before you act. Recall again whenever you reach a
decision that past context might inform.

Memory is automatically scoped to the current project — you do **not** need to pass a project name.

This is **read-only**: use `memory_recall` (and `memory_search` for structured hits). Do not attempt
to write or delete memories from here.
