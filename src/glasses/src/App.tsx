import { useState } from 'react'
import { useEffect } from 'react'
import { Connect } from './screens/Connect'
import { Lab } from './sim/Lab'
import { Phase3App } from './sim/phase3'
import { Phase3FW } from './sim/phase3fw'
import { AppGlasses3c } from './glass/AppGlasses3c'
import { store, useStore } from './store'
import { answer, connectEvents, decide, getPending, getSession, getSessions, sendSteer, setArmed } from './api'
import type { Approval, AskUserQuestionInput, SseEvent } from './types'

/** Pull the session list so the ● needs-you / ◐ live dots reflect the latest
 *  attention state. Fire-and-forget; a stale fetch just loses to the next one. */
function refreshSessions() {
  getSessions('active').then(sessions => store.set({ sessions })).catch(() => {})
}

function applyEvent(e: SseEvent) {
  switch (e.type) {
    case 'hello':
      store.set({ armed: e.armed, approvals: e.pending })
      break
    case 'armed':
      store.set({ armed: e.armed })
      break
    case 'pending':
      // A question just registered (broker-pushed) — surface the card AND light
      // up its session's dot in the list without waiting for the 10s poll.
      store.upsertApproval(e.approval)
      refreshSessions()
      break
    case 'resolved':
      store.removeApproval(e.id)
      refreshSessions()
      break
    case 'notify':
      // a session's attention changed — refresh the list
      refreshSessions()
      break
  }
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * Owns the single connection to the hub (initial fetch + SSE + light poll) and
 * feeds the shared store. Mounted once when connected, so the web dashboard and
 * the glasses HUD (AppGlasses) share one feed instead of opening two. Renders
 * nothing.
 */
function HubFeed() {
  useEffect(() => {
    let stop = () => {}
    let poll: ReturnType<typeof setInterval>
    let detailPoll: ReturnType<typeof setInterval>
    ;(async () => {
      try {
        const [sessions, pending] = await Promise.all([getSessions('active'), getPending()])
        store.set({ sessions, approvals: pending, connection: 'ok' })
      } catch (err) {
        store.set({ connection: 'error', connectionError: String(err) })
      }
      stop = connectEvents(applyEvent, ok => store.set({ connection: ok ? 'ok' : 'error' }))
      // light poll to keep session recency/attention fresh
      poll = setInterval(() => { getSessions('active').then(sessions => store.set({ sessions })).catch(() => {}) }, 10000)
      // refresh the OPEN session's transcript so the detail view updates live —
      // steers and their replies appear without leaving + re-entering the session.
      // Skipped while dictating so a background refresh can't disrupt the mic UI.
      detailPoll = setInterval(() => {
        const st = store.getState()
        if (!st.activeSessionId || st.glassSteering || st.glassListening) return
        const id = st.activeSessionId
        getSession(id)
          .then(d => { if (store.getState().activeSessionId === id) store.set({ activeEvents: d.events }) })
          .catch(() => {})
      }, 3000)
    })()
    return () => { stop(); clearInterval(poll); clearInterval(detailPoll) }
  }, [])
  return null
}

/** First question of an AskUserQuestion approval, plus its option labels (MVP: q[0]). */
function firstQuestion(a: Approval): { text: string; options: string[] } | null {
  const q = (a.tool_input as AskUserQuestionInput)?.questions?.[0]
  if (!q) return null
  return { text: q.question, options: (q.options ?? []).map(o => o.label) }
}

/** A pending AskUserQuestion: pick a listed option or type a free-text ("Other") reply. */
function QuestionCard({ a }: { a: Approval }) {
  const [free, setFree] = useState('')
  const q = firstQuestion(a)
  if (!q) return null
  const send = (text: string) => {
    if (!text.trim()) return
    answer(a.id, { [q.text]: text }, text).catch(() => {})
  }
  return (
    <div className="approval">
      <div className="approval-body">
        <div className="tool">AskUserQuestion · {a.title.replace(/^Ask:\s*/, '')}</div>
        <code>{q.text}</code>
        <div className="muted small">{a.cwd}</div>
        <div className="question-options">
          {q.options.map(label => (
            <button key={label} className="allow" onClick={() => send(label)}>{label}</button>
          ))}
        </div>
        <div className="question-free">
          <input
            placeholder="or type another answer…"
            value={free}
            onChange={e => setFree(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send(free) }}
          />
          <button onClick={() => send(free)}>Send</button>
          <button className="deny" onClick={() => decide(a.id, 'deny', 'cancelled').catch(() => {})}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** Send a free-text steer to a live session (Phase 4c). Delivered to its parked Stop
 *  hook if the session is focused+parked, else queued for its next turn end. */
function SteerBox({ id }: { id: string }) {
  const [msg, setMsg] = useState('')
  const [label, setLabel] = useState('Steer')
  const go = () => {
    if (!msg.trim()) return
    sendSteer(id, msg)
      .then(r => { setLabel(r.accepted ? 'Sent ✓' : 'Disarmed'); if (r.accepted) setMsg(''); setTimeout(() => setLabel('Steer'), 2000) })
      .catch(() => { setLabel('Failed'); setTimeout(() => setLabel('Steer'), 2000) })
  }
  return (
    <div className="question-free">
      <input placeholder="steer this session… (e.g. also update the README)" value={msg}
        onChange={e => setMsg(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go() }} />
      <button onClick={go}>{label}</button>
    </div>
  )
}

function Cockpit() {
  const armed = useStore(s => s.armed)
  const connection = useStore(s => s.connection)
  const sessions = useStore(s => s.sessions)
  const allApprovals = useStore(s => s.approvals)
  const questions = allApprovals.filter(a => a.kind === 'question')
  const approvals = allApprovals.filter(a => a.kind !== 'question')

  const attentionCount = sessions.filter(s => s.needsAttention).length

  return (
    <div className="cockpit">
      <header>
        <div className="brand">
          <span className={`dot ${connection}`} />
          Session Cockpit
        </div>
        <button className={armed ? 'armed' : 'disarmed'} onClick={() => setArmed(!armed).catch(() => {})}>
          {armed ? '● ARMED — routing to me' : '○ Disarmed — normal prompts'}
        </button>
      </header>

      {questions.length > 0 && (
        <section className="approvals">
          <h3>Questions waiting ({questions.length})</h3>
          {questions.map(a => <QuestionCard key={a.id} a={a} />)}
        </section>
      )}

      {approvals.length > 0 && (
        <section className="approvals">
          <h3>Approvals waiting ({approvals.length})</h3>
          {approvals.map(a => (
            <div key={a.id} className="approval">
              <div className="approval-body">
                <div className="tool">{a.tool_name}</div>
                <code>{a.title}</code>
                <div className="muted small">{a.cwd}</div>
              </div>
              <div className="approval-actions">
                <button className="deny" onClick={() => decide(a.id, 'deny').catch(() => {})}>Deny</button>
                <button className="allow" onClick={() => decide(a.id, 'allow').catch(() => {})}>Allow</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="sessions">
        <h3>Sessions ({sessions.length}{attentionCount ? `, ${attentionCount} need you` : ''})</h3>
        {sessions.map(s => (
          <div key={s.id} className={`session ${s.needsAttention ? 'attn' : ''} ${s.live ? 'live' : s.recent ? 'recent' : ''}`}>
            <div className="session-head">
              <span className="title">{s.title || s.project || s.id.slice(0, 8)}</span>
              {s.needsAttention && <span className="badge">needs you</span>}
              <span className="muted small">{timeAgo(s.lastActivityAt)}</span>
            </div>
            <div className="muted small">{s.project} · {s.turns} turns</div>
            {s.lastAssistant && <div className="last">{s.lastAssistant.slice(0, 160)}</div>}
            {s.attention && <div className="attn-msg">⚠ {s.attention.message}</div>}
            {s.live && <SteerBox id={s.id} />}
          </div>
        ))}
        {sessions.length === 0 && <p className="muted">No sessions found.</p>}
      </section>
    </div>
  )
}

export function App() {
  const baseUrl = useStore(s => s.baseUrl)
  // Phase 3 design lab (?sim=lab-*): static bitmap mockups. ?sim=p3: the navigable
  // projects→sessions→detail prototype driven by fixture data.
  // VITE_FORCE_SIM lets a build default to a scenario with no query param — needed
  // on-glasses, where the Even loader drops the query string (?sim never arrives).
  const simName = new URLSearchParams(window.location.search).get('sim')
    ?? (import.meta.env as unknown as Record<string, string | undefined>).VITE_FORCE_SIM
    ?? null
  if (simName?.startsWith('lab-')) return <Lab name={simName} />
  if (simName === 'p3') return <Phase3App />
  if (simName === 'fw') return <Phase3FW />
  if (!baseUrl) return <Connect />
  // Simulator fixture mode (?sim=): the store is pre-seeded, so skip the live feed
  // that would otherwise overwrite it (see main.tsx / sim/fixtures.ts).
  const sim = simName != null
  return (
    <>
      {!sim && <HubFeed />}
      <Cockpit />
      {/* Phase 3c: GlassesSdk element renderer (replaces AppGlasses text-page mode) */}
      <AppGlasses3c />
    </>
  )
}
