import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { line } from 'even-toolkit/types'
import { store, useStore } from '../store'
import { decide, getSession, setArmed } from '../api'
import { toDisplayData, onGlassAction } from './router'
import { attentionSessions, isInterruptActive, reason } from './screens/interrupt'
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
    activeSessionId: st.activeSessionId,
    activeEvents: st.activeEvents,
    detailPage: st.detailPage,
    error: st.glassError,
    dismissedAttentionKey: st.dismissedAttentionKey,
    listening: st.glassListening,
    steering: st.glassSteering,
    interim: st.glassInterim,
  }
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const getSnapshot = useCallback(() => snapshotRef.current, [])

  // --- Image-hero prototype: when the interrupt is active, render a real icon +
  // big-font headline as bitmap tiles ('home' page mode) instead of firmware text.
  const heroActive = isInterruptActive(snapshot)
  const heroSession = heroActive ? attentionSessions(snapshot)[0] ?? null : null
  const heroName = heroSession ? (heroSession.title || heroSession.project || heroSession.id.slice(0, 8)) : ''
  const heroReason = heroSession ? reason(heroSession) : ''
  // The Even icon sprite rasterises asynchronously; re-encode once it's ready.
  const [iconTick, setIconTick] = useState(0)
  useEffect(() => { iconReady.finally(() => setIconTick((t) => t + 1)) }, [])
  // Re-encode only when the shown content (or icon readiness) changes.
  const homeImageTiles = useMemo(
    () => (heroSession ? renderInterruptHero(heroName, heroReason) : undefined),
    [heroSession?.id, heroName, heroReason, iconTick],
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
