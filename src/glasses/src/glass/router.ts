import type { DisplayData, GlassAction, GlassNavState } from 'even-toolkit/types'
import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import type { GlassSnapshot, GlassActions } from './shared'
import { listScreen } from './screens/list'
import { approvalScreen } from './screens/approval'
import { detailScreen } from './screens/detail'
import { interruptScreen, isInterruptActive } from './screens/interrupt'

// Unlike even-toolkit's URL-driven router, the cockpit derives the active screen
// from state so a pending approval can *interrupt* whatever you were looking at.
// Priority: pending approval > unacknowledged attention > open detail > home list.
function pick(snapshot: GlassSnapshot): GlassScreen<GlassSnapshot, GlassActions> {
  if (snapshot.approvals.length > 0) return approvalScreen
  // A notify-driven "needs you" takes over the screen once — until acknowledged
  // (dismissedAttentionKey) or opened. Suppressed while a detail view is open so
  // "tap → review" actually lands on the transcript.
  if (isInterruptActive(snapshot)) return interruptScreen
  if (snapshot.activeSessionId) return detailScreen
  return listScreen
}

export function toDisplayData(snapshot: GlassSnapshot, nav: GlassNavState): DisplayData {
  return pick(snapshot).display(snapshot, nav)
}

export function onGlassAction(
  action: GlassAction,
  nav: GlassNavState,
  snapshot: GlassSnapshot,
  ctx: GlassActions,
): GlassNavState {
  return pick(snapshot).action(action, nav, snapshot, ctx)
}
