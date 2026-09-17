# Intent: The lens gets a Needs-you list; the pushed hero goes
Author: Keith. Status: draft. Source: conversation 2026-09-17 (first day wearing the G2 with slice 6c installed). Issue: k-sym/nexus#477 follow-on (design doc Slice 7). Related: `intent/2026-09-15-needs-you-attention-collection.md`.

## Problem
Every time the Session Cockpit opens on the G2 it shows the bell hero — "NEEDS YOU · <one item>" —
and takes the screen until each item is dismissed. The "seen" mark lives only in memory and Even
wipes the app on close, so nothing stays acknowledged across launches; since 6c a night summary
notice is enough to raise it. There is no list of items on the lens at all: attention items exist
only inside the hero, one at a time, swipe to page. The phone got this right as a list.

## Proposed outcome
- A **Needs-you list** on the lens, a third home screen beside Projects and Sessions: one row per
  live item (glyph, title, why), actions before notices, a title like "3 to action · 1 to see".
- Tap on a row opens an **item card** whose gestures are the item's `lens_verbs` — the footer the
  hero draws today — plus a way back. Nothing new is invented: the partner's lens subset stays.
- **The hero goes.** No pushed screen for attention items; Even's notification mirroring of the
  phone's push already covers "something new arrived" on the lens. The approval screen is untouched.
- On launch with open actions, the cockpit opens on the Needs-you list with the count in the title;
  otherwise on Projects as today.

## Affected users and systems
Keith on the G2. `src/glasses` only: `glass/router.ts` (priority without the interrupt), the 3c HUD
(`AppGlasses3c.tsx` home/nav states and gesture map), a new `screens/needs-you.ts` + item card,
`glass/attention.ts` (entries, labels, tap plan reused), `sim/fixtures.ts` + `sim/preview.tsx`,
`app.json` bump + repack. The gateway route and the partner are unchanged.

## Constraints
- Verbs stay gated on the item's `lens_verbs` ∩ `verbs` and its status; never `open`, never `close`.
- Sessions blocking on a human (the thread-born half of today's hero) must still be reachable:
  they keep their ● row in the Sessions list; whether they also join the Needs-you list is open.
- Ten firmware-text lines, 44 columns, the existing list/footer helpers; the `?sim=preview`
  fixtures must show the new screens without a gateway.
- The installed `.ehpk` is a separate artifact: bump, pack, Keith reinstalls.

## Open questions
- Do sessions needing input also list under Needs you (one list, two sources), or stay in Sessions only?
- Does a tap on a row run the item's first lens verb straight away (as the hero does), or always open the card first?
- Should the list be the launch screen only when there are open actions, or always?
