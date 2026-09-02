# Nexus Agent Bridge v1

**Issue:** [#249](https://github.com/k-sym/nexus/issues/249)

**Status:** Initial safe slice implemented

**Date:** 2026-09-02

## Outcome

Nexus now has an optional backend-owned bridge ingress for thread-directed messages from
other agent harnesses. It uses one NATS connection for the Nexus process, a durable
JetStream consumer, and a SQLite inbox. The bridge is disabled by default and supports:

- **Notify only** — persist and display a message without starting work.
- **Queue for approval** — persist and display a message; a human may explicitly run it
  through the existing chat endpoint in the addressed thread.

There is deliberately no Pi extension and no direct `sendMessage({ triggerTurn: true })`
path. An approved message becomes a normal chat turn, so the existing project claim,
model selection, Activity stream, supervision gates, and tool approval behavior remain
authoritative.

## Decisions

### SQLite inbox plus JetStream

JetStream covers broker-side offline delivery. SQLite remains Nexus's audit and UI source
of truth. A JetStream message is acknowledged only after the synchronous SQLite ingest
finishes. Envelope IDs are primary keys, so redelivery and sender retries are idempotent.

The stream retains up to 24 hours, 1,000 messages per Nexus instance subject, and 64 MiB
overall. The SQLite inbox has no automatic retention policy in this slice.

### Nexus-specific namespace

The upstream `bridge.dm.{agent}` contract does not carry a project/thread target and its
canonical `pi` subscription can fan a message into the wrong cached session. Nexus uses:

```text
nexus.bridge.v1.inbox.{instanceId}
```

The subject selects exactly one Nexus backend. The versioned JSON envelope selects the
project and thread. A Claude Code adapter can publish this envelope directly; adapting
the upstream MCP `send` tool is preferable to installing its Pi extension in Nexus.

### Stable identity

Fresh configs derive a stable, non-secret instance ID from the host and Nexus state-root.
Users may replace it in Settings. The target is always the tuple:

```text
instanceId + projectId + threadId
```

The database verifies that the thread exists and belongs to the stated project. Messages
for another instance, project, or thread are stored as rejected and never run.

### Trust boundary

- Disabled by default.
- Exact sender allowlist; an empty list allows nobody. `*` is an explicit allow-all.
- 64 KiB default message limit.
- 30 messages per sender per minute by default.
- Four-hop default ceiling.
- Remote brokers require `tls://` and a token.
- Broker tokens support environment interpolation, are resolved server-side, and are
  masked by the Settings API.
- Message text is prefixed as an untrusted external message before it enters chat.
- No autonomous mode is exposed in v1.

## Envelope

```json
{
  "version": 1,
  "kind": "message",
  "id": "01J8EXAMPLE",
  "sentAt": "2026-09-02T10:00:00.000Z",
  "sender": {
    "id": "claude-reviewer",
    "displayName": "Claude reviewer",
    "harness": "claude-code"
  },
  "target": {
    "instanceId": "nexus-a1b2c3d4e5",
    "projectId": "project-uuid",
    "threadId": "thread-uuid"
  },
  "content": "Review the authentication path and report findings.",
  "correlationId": "optional-request-id",
  "replyTo": "optional-agent-id",
  "hopCount": 0
}
```

IDs use letters, numbers, dots, underscores, colons, and hyphens, up to 128 characters.
The instance ID is a NATS subject token and therefore excludes dots.

## Lifecycle

```text
JetStream delivery
  → validate envelope and policy
  → persist in SQLite
  → acknowledge broker delivery
  → received (notify-only)
     or pending_approval (queue mode)
       → rejected
       or running → completed / failed
```

Approving a message requires the target thread to have a previously selected model. The
backend sends the message to its own normal streaming chat route over loopback. Busy
projects, unavailable models, and other ordinary chat refusals are recorded as bridge
failures rather than bypassed.

## User experience

Settings contains one Agent Bridge card with a single primary enable control, an explicit
inbound-behavior selector, broker/identity/allowlist fields, progressively disclosed
safety limits, runtime connection state, and the durable inbox. Pending messages expose
large labelled **Run in target thread** and **Reject** actions. The Trust & Privacy card
also reports the broker destination, credential source, and SQLite inbox storage.

## Built files

- `src/backend/agent-bridge/protocol.ts` — versioned envelope and config validation.
- `src/backend/agent-bridge/store.ts` — durable inbox, deduplication, routing checks, and
  state transitions.
- `src/backend/agent-bridge/service.ts` — one NATS/JetStream connection and consumer.
- `src/backend/routes/agent-bridge.ts` — status, inbox, HTTP diagnostic ingress, approval,
  rejection, and managed-turn adapter.
- `src/frontend/src/components/AgentBridgeInbox.tsx` — runtime state and approval UI.

## Deliberate deviations and follow-ups

The issue's complete proposal is larger than a safe first release. This slice does not:

- advertise presence or rooms;
- publish structured completion replies to `replyTo`;
- create Nexus threads from external messages;
- provide autonomous mode;
- provide per-project/per-thread enable controls;
- implement a dead-letter/retry UI or inbox retention controls;
- ship the companion Claude Code MCP adapter.

Those should be separate follow-ups. Presence should describe Nexus threads without
subscribing each embedded Pi session. Completion replies should use an outbox table and
increment `hopCount` before autonomous behavior is considered.

## Testing notes

The testing agent should verify:

1. Fresh and upgraded databases create `agent_bridge_messages` and its indexes.
2. Duplicate delivery creates one inbox row and one notification.
3. Two threads in one project cannot receive each other's addressed messages.
4. Unknown senders, wrong project/thread targets, excessive hops, and rate overflow are
   persisted as rejected and cannot be approved.
5. Notify-only messages offer no run action.
6. Queue-mode approval uses the target thread's model and appears as a normal Activity
   chat turn, including project concurrency and supervision behavior.
7. Restarting Nexus reuses the durable consumer and SQLite inbox without replaying work.
8. A broker outage leaves the backend usable and reports an error in Settings; recovery
   reconnects without creating another backend connection.
9. Remote `nats://` and tokenless remote `tls://` configurations are rejected.
10. Light/dark themes, keyboard focus, Dynamic Type/zoom, and narrow layouts keep all
    bridge controls readable and tappable.
