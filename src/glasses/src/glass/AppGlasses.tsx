import { useCallback, useRef } from 'react'
import { useGlasses } from 'even-toolkit/useGlasses'
import { store, useStore } from '../store'
import { decide, getSession, resolveAttention, setArmed } from '../api'
import { toDisplayData, onGlassAction } from './router'
import { verbToast, isNoticeItem } from './attention'
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
    attentionReady: st.attentionReady,
    activeSessionId: st.activeSessionId,
    activeEvents: st.activeEvents,
    detailPage: st.detailPage,
    error: st.glassError,
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
    // Fire-and-acknowledge (design D15): drop the item from the list now, say
    // what was sent in one line, and let the next poll be the truth. A refusal
    // shows the partner's sentence the same way.
    resolveAttention(id, verb) {
      // A notice's dismiss was offered as "Seen"; say the same when it lands (D36).
      const notice = store.getState().attention.some((i) => i.id === id && isNoticeItem(i))
      store.removeAttention(id)
      resolveAttention(id, verb, verb === 'snooze' ? 'tomorrow' : undefined)
        .then(() => store.setGlassError(verbToast(verb, notice)))
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
    toDisplayData,
    onGlassAction: handleAction,
    deriveScreen,
    appName: 'SESSION COCKPIT',
  })

  return null
}
