import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { line } from 'even-toolkit/types'
import { store, useStore } from '../store'
import { decide, getSession, resolveAttention, setArmed } from '../api'
import { toDisplayData, onGlassAction } from './router'
import { attentionEntriesOf, entryName, entryReason, isInterruptActive } from './screens/interrupt'
import { tapPlan, verbToast, heroHeadline } from './attention'
import { renderInterruptHero, iconReady } from './hero'
import { padTo } from './theme'
import type { GlassSnapshot, GlassActions } from './shared'

// Drives the G2 glasses HUD off the shared cockpit store. Renders nothing to the
// DOM — the web dashboard is the companion view; this is the glasses view. Both
// read the same store, which is fed once at the App level (see App.tsx).
export function AppGlasses() {
  // One subscription to the whole store; rebuild the immutable snapshot per change.
  const st = useStore((s) => s)
  const snapshot: GlassSnapshot = {
    connection: st.connection,
    armed: st.armed,
    sessions: st.sessions,
    approvals: st.approvals,
    attention: st.attention,
    activeSessionId: st.activeSessionId,
    activeEvents: st.activeEvents,
    detailPage: st.detailPage,
    error: st.glassError,
    dismissedAttentionKey: st.dismissedAttentionKey,
    listening: st.glassListening,
    steering: st.glassSteering,
    interim: st.glassInterim,
    pendingSteer: st.glassPendingSteer,
    questionId: st.glassQuestionId,
    questionIdx: st.glassQuestionIdx,
  }
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const getSnapshot = useCallback(() => snapshotRef.current, [])

  // --- Image-hero prototype: when the interrupt is active, render a real icon +
  // big-font headline as bitmap tiles ('home' page mode) instead of firmware text.
  // Two sources, one hero (#477): sessions blocking on a human, then the partner's
  // open attention items. The footer's gesture labels come from the entry.
  const heroActive = isInterruptActive(snapshot)
  const heroEntry = heroActive ? attentionEntriesOf(snapshot)[0] ?? null : null
  const heroName = heroEntry ? entryName(heroEntry) : ''
  const heroReason = heroEntry ? entryReason(heroEntry) : ''
  const heroPlan = heroEntry ? tapPlan(heroEntry) : null
  const heroFooterKey = heroPlan ? `${heroPlan.tapLabel}/${heroPlan.doubleTapLabel}` : ''
  // The Even icon sprite rasterises asynchronously; re-encode once it's ready.
  const [iconTick, setIconTick] = useState(0)
  useEffect(() => { iconReady.finally(() => setIconTick((t) => t + 1)) }, [])
  // Re-encode only when the shown content (or icon readiness) changes.
  const homeImageTiles = useMemo(
    () => (heroEntry && heroPlan
      ? renderInterruptHero(heroName, heroReason, { tap: heroPlan.tapLabel, doubleTap: heroPlan.doubleTapLabel }, heroHeadline(heroEntry))
      : undefined),
    [heroEntry?.kind, heroEntry?.id, heroName, heroReason, heroFooterKey, iconTick],
  )
  // In image mode the bitmap is the ENTIRE screen (icon, headline, gesture footer),
  // so the firmware text layer is blank — nothing left to read like a terminal.
  const toDisplay = useCallback((snap: GlassSnapshot, nav: Parameters<typeof toDisplayData>[1]) => {
    if (isInterruptActive(snap)) return { lines: padTo([line('')]) }
    return toDisplayData(snap, nav)
  }, [])
  const getPageMode = useCallback(
    () => (isInterruptActive(snapshotRef.current) ? ('home' as const) : ('text' as const)),
    [],
  )

  // Stable side-effect handlers. api.ts reads creds from the store each call.
  const actionsRef = useRef<GlassActions>({
    toggleArmed() {
      setArmed(!store.getState().armed).catch((e) => store.setGlassError(`arm failed: ${e}`))
    },
    async openSession(id) {
      try {
        const detail = await getSession(id)
        store.openDetail(id, detail.events)
      } catch (e) {
        store.setGlassError(`load failed: ${e}`)
      }
    },
    closeDetail() {
      store.closeDetail()
    },
    allow(id) {
      store.removeApproval(id) // optimistic; SSE 'resolved' confirms
      decide(id, 'allow').catch((e) => store.setGlassError(`allow failed: ${e}`))
    },
    deny(id) {
      store.removeApproval(id)
      decide(id, 'deny').catch((e) => store.setGlassError(`deny failed: ${e}`))
    },
    dismissInterrupt(key) {
      store.dismissInterrupt(key)
    },
    // Fire-and-acknowledge (design D15): drop the item from the hero now, say
    // what was sent in one line, and let the next poll be the truth. A refusal
    // shows the partner's sentence the same way.
    resolveAttention(id, verb) {
      store.removeAttention(id)
      resolveAttention(id, verb, verb === 'snooze' ? 'tomorrow' : undefined)
        .then(() => store.setGlassError(verbToast(verb)))
        .catch((e) => store.setGlassError(`${verb} failed: ${e instanceof Error ? e.message : e}`))
    },
  })

  const handleAction = useCallback(
    (action: Parameters<typeof onGlassAction>[0], nav: Parameters<typeof onGlassAction>[1], snap: GlassSnapshot) =>
      onGlassAction(action, nav, snap, actionsRef.current),
    [],
  )

  const deriveScreen = useCallback(() => 'root', [])

  useGlasses<GlassSnapshot>({
    getSnapshot,
    toDisplayData: toDisplay,
    onGlassAction: handleAction,
    deriveScreen,
    getPageMode,
    homeImageTiles,
    appName: 'SESSION COCKPIT',
  })

  return null
}
