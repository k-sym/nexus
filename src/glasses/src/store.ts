import { useSyncExternalStore } from 'react'
import { storageSetRaw } from 'even-toolkit/storage'
import type { Approval, ConnectionStatus, SessionSummary, TranscriptEvent } from './types'

export interface State {
  baseUrl: string
  token: string
  connection: ConnectionStatus
  connectionError: string | null
  armed: boolean
  sessions: SessionSummary[]
  approvals: Approval[] // pending only
  error: string | null

  // --- glass HUD state (Phase 3b) — the web dashboard ignores these ---
  activeSessionId: string | null   // set => detail screen is open on the glasses
  activeEvents: TranscriptEvent[]  // transcript for the open session
  detailPage: number               // Phase 2: which page of the latest reply the detail card shows (0 = top)
  glassError: string | null        // transient toast for the glasses HUD
  glassListening: boolean          // Phase 4b: mic is open, transcribing a voice answer
  glassSteering: boolean           // Phase 4c: mic is open, transcribing a free-text steer
  glassInterim: string             // live (interim) transcript shown while listening/steering
  // A just-sent steer, echoed in the detail view as "you › …" until the agent's next
  // reply lands. `baseReply` = the latest reply at send-time; once the live reply
  // differs from it, the response has arrived and the echo gives way to it.
  glassPendingSteer: { text: string; baseReply: string } | null
  // Attention-interrupt bookkeeping: the set of attention session-ids the user has
  // already acknowledged, keyed as a sorted join. While it matches the live set the
  // interrupt stays dismissed; a new/changed attention set re-raises it.
  dismissedAttentionKey: string | null
}

const LS_URL = 'cockpit.baseUrl'
const LS_TOKEN = 'cockpit.token'

let state: State = {
  baseUrl: localStorage.getItem(LS_URL) || '',
  token: localStorage.getItem(LS_TOKEN) || '',
  connection: 'unknown',
  connectionError: null,
  armed: false,
  sessions: [],
  approvals: [],
  error: null,
  activeSessionId: null,
  activeEvents: [],
  detailPage: 0,
  glassError: null,
  glassListening: false,
  glassSteering: false,
  glassInterim: '',
  glassPendingSteer: null,
  dismissedAttentionKey: null,
}

const listeners = new Set<() => void>()
function emit() { for (const l of listeners) l() }

export const store = {
  getState(): State { return state },
  subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l) },
  set(patch: Partial<State>) { state = { ...state, ...patch }; emit() },
  setCredentials(baseUrl: string, token: string) {
    const clean = baseUrl.replace(/\/$/, '')
    // window.localStorage is a fast cache but is WIPED on app close in the Even
    // WebView, so also mirror creds to the Even app's NATIVE store (via the bridge),
    // which survives restarts. Fire-and-forget; a no-op outside the Even app.
    localStorage.setItem(LS_URL, clean)
    localStorage.setItem(LS_TOKEN, token)
    void storageSetRaw(LS_URL, clean)
    void storageSetRaw(LS_TOKEN, token)
    state = { ...state, baseUrl: clean, token, connection: 'unknown', connectionError: null }
    emit()
  },
  upsertApproval(a: Approval) {
    const rest = state.approvals.filter(x => x.id !== a.id)
    state = { ...state, approvals: a.decision ? rest : [...rest, a] }
    emit()
  },
  removeApproval(id: string) {
    state = { ...state, approvals: state.approvals.filter(a => a.id !== id) }
    emit()
  },
  openDetail(id: string, events: TranscriptEvent[]) {
    // Reset to the top of the latest reply whenever a session opens.
    state = { ...state, activeSessionId: id, activeEvents: events, detailPage: 0 }
    emit()
  },
  dismissInterrupt(key: string) {
    state = { ...state, dismissedAttentionKey: key }
    emit()
  },
  closeDetail() {
    state = { ...state, activeSessionId: null, activeEvents: [], detailPage: 0, glassSteering: false, glassInterim: '', glassPendingSteer: null }
    emit()
  },
  setGlassError(msg: string | null) {
    state = { ...state, glassError: msg }
    emit()
  },
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()))
}
