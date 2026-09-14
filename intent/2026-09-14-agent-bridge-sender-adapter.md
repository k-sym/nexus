# Intent: Agent Bridge sender adapter
Author: Keith. Status: draft. Source: issue #451 and 2026-09-14 conversation.

## Problem
External agent sessions still copy findings into Nexus manually. The bridge receives
messages and sends approved replies, but has no installable sender or result reader.

## Proposed outcome
A separately installable CLI and MCP server in this monorepo lets external Claude Code
or Codex sessions address a scoped Nexus project/thread by name and receive replies.

## Affected users and systems
Keith; new src/bridge-client package, backend target discovery route, laptop/other
sender hosts, baker-pro backend and broker. No iOS changes.

## Constraints
- Preserve v1 envelopes, sender allowlisting, project scope and human run/reply approval.
- No new agent-reachable backend write tools; client sends only to the broker.
- Credentials come from environment only, never persisted or echoed by the client.
- Require TLS and token for remote brokers; open no network listeners.
- Retry a failed send with the same ID; separate sends get separate IDs.
- Preserve the unrelated local iOS project-file edit.

## Open questions
Design defaults for approval: fire-and-follow rather than waiting for a run in send;
explicit stable sender ID per machine/harness; durable local send/reply state.
