# Intent: Read an item on the lens before acting on it
Author: Keith. Status: draft. Source: conversation 2026-09-18, first real walk of the Needs-you list on the G2 (app v0.2.1). Issue: k-sym/nexus#477 follow-on (design doc Slice 8). Related: `intent/2026-09-17-lens-needs-you-list.md` (Slice 7).

## Problem
The item card on the lens offers the verbs and nothing else: a Morning brief can only be marked
"Seen", a waiting mail can only be drafted, snoozed or dismissed. "In order to action, I need to
know what I'm actioning, not make a decision based on the headline." The phone shows a notice's
body and, since 6d, the latest message behind a mail item; the lens shows neither. The gateway's
lens projection drops the item's body altogether, and the thread route (`GET
/api/attention/:id/thread`, live since 6d) has no gateway counterpart.

## Proposed outcome
- The item card gains a **Read** row, first, whenever there is something to read: the item's
  body (a notice's digest, a meeting pack, a PR review's note) or, for a `mail.*` item, the
  latest message of its thread fetched on demand through the gateway.
- Reading opens a paged text screen in the detail card's shape — the title in the header bar
  with page k/N, the text wrapped to the lens width, seven rows a page. Scroll pages; double-tap
  returns to the card, where the verbs are one tap away. Nothing is recorded by reading.
- A mail message shows who sent it and when above the text; a body that is not readable today
  (a Google mailbox) shows the partner's sentence, as the phone does.

## Affected users and systems
Keith on the G2. Gateway (`src/backend/gateway`): `body` on the lens item, a new
`GET /api/attention/:id/thread` forwarding the partner's message via the existing client method.
Glasses (`src/glasses`): API, types, a `read` screen in the 3c HUD, fixtures and preview, tests,
`app.json` bump and repack. No partner change; no phone or desktop change.

## Constraints
- Read-only: no `open` event is recorded from the lens (the phone records one; the lens has no
  browser and `open` is not a lens verb).
- The message text is shown to a person and never fed to a model; it is fetched when Read is
  chosen, never in the 10 s poll.
- Firmware limits: text containers page at seven rows; list items stay under 63 bytes.
- The body (partner-clipped, ≤2000 chars) and a message (≤4000) both page; the lens clips neither.

## Open questions
- On the last page of a notice, should a tap mark it Seen straight away, or always go back to the card first?
- Should a mail item's Read fetch the message when the card opens (one call per card) or only on the Read tap?
- Does a `meeting.prep` item also want its vault page (the pack) readable, or is the T-2 body enough?
