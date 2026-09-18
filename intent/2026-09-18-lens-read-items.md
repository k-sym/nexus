# Intent: Read an item on the lens before acting on it
Author: Keith. Status: accepted (2026-09-18). Source: conversation 2026-09-18, first real walk of the Needs-you list on the G2 (app v0.2.1). Issue: k-sym/nexus#477 follow-on (design doc Slice 8). Related: `intent/2026-09-17-lens-needs-you-list.md` (Slice 7).

## Problem
The item card on the lens offers the verbs and nothing else: a Morning brief can only be marked
"Seen", a waiting mail only drafted, snoozed or dismissed. "In order to action, I need to know what
I'm actioning, not make a decision based on the headline." The phone shows a notice's body and,
since 6d, the latest message behind a mail item; the lens shows neither — the gateway's lens
projection drops the body, and the thread and page routes have no gateway counterpart.

## Proposed outcome
- The item card gains a **Read** row, first, whenever there is something to read: the item's
  body (a notice's digest, a PR review's note), a meeting item's vault page, or, for a `mail.*`
  item, the latest message of its thread — the last two fetched on demand through the gateway.
- Reading opens a paged text screen in the detail card's shape — the title in the header bar
  with page k/N, the text wrapped to the lens width, seven rows a page. Scroll pages; double-tap
  returns to the card, where the verbs are one tap away. Nothing is recorded by reading.
- A mail message shows who sent it and when above the text; a body that is not readable today
  (a Google mailbox) shows the partner's sentence, as the phone does.

## Affected users and systems
Keith on the G2. Gateway (`src/backend/gateway`): `body` on the lens item, `GET /api/attention/:id/thread` and
`/page` forwarding what the phone's routes already serve, and a `file` action for the To-do row.
Glasses (`src/glasses`): API, types, a `read` screen in the 3c HUD, fixtures and preview, tests,
`app.json` bump and repack. No partner change; no phone or desktop change.

## Constraints
- Reading records nothing (`open` is not a lens verb); the text is shown to a person, never fed
  to a model, and fetched on the Read tap, never in the 10 s poll.
- Firmware limits: text containers page at seven rows; list items stay under 63 bytes.
- The body (partner-clipped, ≤2000 chars) and a message (≤4000) both page; the lens clips neither.

## Decided (Keith, 2026-09-18)
- On a notice's last page, a tap marks it Seen straight away.
- A mail item's message is fetched only on the Read tap; the verbs stay on the card, so an item
  whose content is known can be dismissed without reading.
- A `meeting.prep` item's vault page (the pack) is readable too, and the card gains a **To-do**
  action: reading a pack may call for prep work, which Keith wants queued as a Board to-do from
  the lens — the phone's "File as a to-do", landing on the producer's suggested project.
