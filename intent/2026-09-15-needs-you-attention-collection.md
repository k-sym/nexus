# Intent: "Needs you" as a collection across desktop, phone and glasses
Author: Keith. Status: accepted. Issue: #477. Source: 2026-09-15 conversation. Partner half: k-sym/baker-internal#140, `baker-internal/intent/2026-09-15-needs-you-attention-collection.md`.

## Problem
"Needs you" is derived only from a running thread's pending questions and approvals
(`src/backend/board/lanes.ts`), pushed for approvals and long runs, and shown on the
glasses as the interrupt hero. Everything the partner routines want from Keith (waiting
mail, drafts, meeting packs, ratchet proposals) arrives as Telegram text outside Nexus,
with no card, no push and no verb, and gets skimmed. Keith wants one collection he can
work deeply on the desktop, from a card on the phone, and from a glance on the lens.

## Proposed outcome
Nexus proxies the partner's attention items (`/api/attention`, routines-card pattern)
and renders one "Needs you" set that unions thread-born items with partner items:
- Desktop: full item with context and its verbs in the Partner view; Board lane unchanged
  unless decided otherwise (open question).
- Phone: a card with the item's verbs; one APNs push per new item through the existing
  sender with deep link `attention:<id>`; badge counts items, not only approvals.
- Glasses (`src/glasses`): the interrupt hero fed from the same set; tap resolves with the
  item's lens-allowed verbs, double-tap dismisses. The lens alert itself is free: Nexus
  pushes mirror to the G2 through the Even app (proven 2026-09-15).

## Affected users and systems
Keith on desktop, iPhone (Xcode build, APNs sandbox), G2. `src/backend` (proxy route,
push wiring, shared types), `src/frontend` Partner view, `ios/App` + `ios/NexusCore`
(card, deep-link routing, badge), `src/glasses` (hero source + verbs). Deploy: baker-pro.

## Constraints
- Nexus stores nothing about items beyond a seen/badge cache; the partner is canonical.
- Thread-born needs-you keeps its current derivation; the union happens in the view.
- Verbs offered per surface come from the item record; the client never invents one.
  Send and approve are never lens or push-action verbs.
- Migrations additive; no new external write; iOS stays tolerant of a backend without
  the route (absent means hidden).
- Tests per Development conventions; iOS is not in CI, Keith builds.

## Open questions
- Do partner items join the Board's Needs you lane, or only the Partner view and Pulse?
- Push every item, or only kinds Keith marks as interrupt-worthy?
- Does the glasses hero need a list when several items are pending, or newest-first only?
