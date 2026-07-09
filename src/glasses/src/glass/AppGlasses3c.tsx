// Phase 3c renderer — drives the G2 HUD via even-toolkit's GlassesSdk element
// composition (bordered cards, positioned elements, native list selection) instead
// of useGlasses' fixed text-page modes. Replaces <AppGlasses/>. Renders nothing to
// the DOM; the web dashboard is the companion view.
//
// v1: the session LIST is a full native card (rail + bordered list + selection);
// approval / detail / interrupt are functional bordered-text placeholders, ported
// to rich compositions next. The bitmap interrupt hero (image container) is the
// known follow-up — GlassesPage composes text+list only.
import { useEffect, useRef } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'
import {
  CreateStartUpPageContainer, RebuildPageContainer,
  TextContainerProperty, ImageContainerProperty, ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'
import { STTEngine } from 'even-toolkit/stt'
import { paginateText } from 'even-toolkit/paginate-text'
import { getTextWidth } from 'even-toolkit/pretext'
import { store } from '../store'
import { answer, decide, getSession, sendSteer, setSteerFocus } from '../api'
import { attentionSessions, isInterruptActive, reason } from './screens/interrupt'
import { renderInterruptHero, iconReady } from './hero'
import { matchAnswer, sttConfig } from './stt'
import type { GlassSnapshot } from './shared'
import type { Approval, AskUserQuestionInput, SessionSummary, TranscriptEvent } from '../types'

// Phase 3 nav: the flat session list is replaced by a projects → sessions drill-down
// (the locked firmware-text design). approval / question / interrupt still hard-take
// over the HUD from wherever you are; detail is a session opened from the sessions list.
type Screen = 'approval' | 'question' | 'interrupt' | 'detail' | 'projects' | 'sessions'

// Where the "home" nav sits when nothing is taking over the HUD. `detail` is not
// stored here — it's implied by store.activeSessionId (so it survives store updates
// and reuses the existing steer/paging machinery).
interface Nav { home: 'projects' | 'sessions'; projIdx: number }

const BORDER = 0xffffff as never // maps to green on the monochrome lens
// Sentinel row id for the "speak your answer" option on the question screen.
const SPEAK = '__speak__'

// Locked status glyphs (verified to render in a firmware LIST): ◆ needs you,
// ⊙ live (running), ○ idle. ★ is the Assistant PROJECT badge (see projBadge).
const GLYPH = { needs: '◆', live: '⊙', idle: '○' } as const
function sessionGlyph(s: SessionSummary): string {
  return s.needsAttention ? GLYPH.needs : s.live ? GLYPH.live : GLYPH.idle
}

// A project grouping of the flat session list. Keyed by projectId (falling back to
// the project name), so chat threads of one project collapse into a single row.
interface ProjGroup { key: string; name: string; badge: string; asst: boolean; sessions: SessionSummary[] }

function projBadge(name: string, asst: boolean): string {
  if (asst) return '★' // the Assistant project reads as "special"
  const m = name.match(/[a-z0-9]/i)
  return (m ? m[0] : name[0] ?? '·').toUpperCase()
}

/** Group the live session list by project, preserving recency order (sessions arrive
 *  sorted newest-first, so a project's first-seen session fixes its rail position). */
function groupProjects(sessions: SessionSummary[]): ProjGroup[] {
  const byKey = new Map<string, ProjGroup>()
  const order: string[] = []
  for (const s of sessions) {
    const asst = s.kind === 'assistant'
    const key = s.projectId ?? s.project ?? (asst ? 'Assistant' : 'other')
    let g = byKey.get(key)
    if (!g) {
      const name = s.project || (asst ? 'Assistant' : 'project')
      g = { key, name, badge: projBadge(name, asst), asst, sessions: [] }
      byKey.set(key, g); order.push(key)
    }
    g.sessions.push(s)
  }
  return order.map((k) => byKey.get(k) as ProjGroup)
}

// An AskUserQuestion registers through the same channel as a tool approval; split by
// kind so the two get their own screens (gates → allow/deny, questions → pick answer).
function gates(s: GlassSnapshot): Approval[] { return s.approvals.filter(a => a.kind !== 'question') }
function questions(s: GlassSnapshot): Approval[] { return s.approvals.filter(a => a.kind === 'question') }

// First question + its option labels (MVP: q[0] only; multi-question is a follow-up).
function firstQuestion(a: Approval): { text: string; options: string[] } | null {
  const q = (a.tool_input as AskUserQuestionInput)?.questions?.[0]
  if (!q) return null
  return { text: q.question, options: (q.options ?? []).map(o => o.label) }
}

function pickScreen(s: GlassSnapshot, nav: Nav): Screen {
  if (gates(s).length > 0) return 'approval'
  if (questions(s).length > 0) return 'question'
  if (isInterruptActive(s)) return 'interrupt'
  if (s.activeSessionId) return 'detail'
  return nav.home // 'projects' (home) | 'sessions' (drilled into a project)
}

// Resolve a spoken transcript into an answer and post it. Module-level so both the STT
// callback and the stop-tap gesture can call it; guarded so double-fire is a no-op.
function finalizeVoiceAnswer(text: string) {
  const st = store.getState()
  if (!st.glassListening) return
  const a = questions(glass(st))[0]
  const fq = a && firstQuestion(a)
  store.set({ glassListening: false, glassInterim: '' })
  if (!a || !fq) return
  const chosen = matchAnswer(text, fq.options)
  if (!chosen) return // nothing heard — drop back to the question, no answer sent
  store.removeApproval(a.id)
  answer(a.id, { [fq.text]: chosen }, chosen).catch((e) => store.setGlassError(`answer failed: ${e}`))
}

// Post a spoken steer to the open (focused) session. Module-level so the STT callback
// and the tap gesture both reach it; guarded so a double-fire is a no-op.
function finalizeSteer(text: string) {
  const st = store.getState()
  if (!st.glassSteering) return
  const id = st.activeSessionId
  store.set({ glassSteering: false, glassInterim: '' })
  const msg = text.trim()
  if (!id || !msg) return // nothing heard — stay on the detail screen, no steer sent
  // Echo the sent steer in the detail view (you › …) until the agent's next reply
  // lands — so you see what you said before the response comes back.
  store.set({ glassPendingSteer: { text: msg, baseReply: latestReplyText(st.activeEvents) } })
  sendSteer(id, msg)
    .then((r) => { if (!r.accepted) { store.setGlassError('steer not sent'); store.set({ glassPendingSteer: null }) } })
    .catch((e) => { store.setGlassError(`steer failed: ${e}`); store.set({ glassPendingSteer: null }) })
}

// Scroll paging for the detail screen's latest-reply card. Clamps to the reply's
// page count; a no-op while steering (the mic sub-view owns the card) or when the
// whole reply fits on one page. Module-level so the gesture handler can call it.
function pageDetail(delta: number) {
  const st = store.getState()
  if (st.glassSteering) return
  const total = replyPages(st.activeEvents).length
  if (total <= 1) return
  const next = Math.max(0, Math.min(total - 1, st.detailPage + delta))
  if (next !== st.detailPage) store.set({ detailPage: next })
}

function ageShort(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Session-row label for the sessions list: status glyph · name · needs-you|age.
function sessionRow(s: SessionSummary): { id: string; label: string } {
  const name = (s.title || s.project || s.id.slice(0, 8)).slice(0, 24)
  const meta = s.needsAttention ? 'needs you' : ageShort(s.lastActivityAt)
  return { id: s.id, label: `${sessionGlyph(s)}  ${name}   ·   ${meta}` }
}

// A compact signature of what's on screen — skip re-rendering (and resetting native
// selection) when a store update doesn't actually change the display.
function signature(s: GlassSnapshot, scr: Screen, nav: Nav, groups: ProjGroup[]): string {
  if (scr === 'projects')
    return `proj|${s.connection}|${groups.map((g) => `${g.badge}${g.name}${g.sessions.length}${g.sessions.some((x) => x.needsAttention) ? '!' : ''}`).join('~')}`
  if (scr === 'sessions')
    return `sess|${nav.projIdx}|${groups.map((g) => g.badge).join('')}|${(groups[nav.projIdx]?.sessions ?? []).map((x) => sessionRow(x).label).join('~')}`
  if (scr === 'detail') return `detail|${s.activeSessionId}|${latestReplyText(s.activeEvents).length}|${s.detailPage}|${s.steering ? 'S' : ''}|${s.interim}|${s.error ?? ''}|${s.pendingSteer ? `P${s.pendingSteer.text.length}:${s.pendingSteer.baseReply.length}` : ''}`
  if (scr === 'approval') return `appr|${gates(s).map((a) => a.id).join(',')}`
  if (scr === 'question') { const a = questions(s)[0]; const q = a && firstQuestion(a); return `q|${a?.id}|${s.listening ? 'L' : ''}|${s.interim}|${s.error ?? ''}|${q ? q.options.join('~') : ''}` }
  return `intr|${attentionSessions(s).map((a) => a.id).join(',')}`
}

export function AppGlasses3c() {
  const sdkRef = useRef<GlassesSdk | null>(null)
  // index→row map for the current list, so a tap event resolves to a project/session.
  const rowsRef = useRef<{ id: string; label: string }[]>([])
  const screenRef = useRef<Screen>('projects')
  const sigRef = useRef<string>('')
  // Home nav position (projects list, or drilled into one project's sessions). Detail
  // is implied by store.activeSessionId, so it isn't tracked here.
  const navRef = useRef<Nav>({ home: 'projects', projIdx: 0 })

  useEffect(() => {
    const sdk = new GlassesSdk()
    sdkRef.current = sdk

    // even-toolkit's STT GlassBridgeSource reads window.__evenBridge (normally set by
    // useGlasses, which the Phase-3c renderer doesn't use). Provide the minimal shape it
    // needs — the raw bridge for mic audioControl + onEvent forwarding to our SDK's event
    // stream — instead of the full page-managing EvenHubBridge, which would fight us.
    GlassesSdk.getRawBridge()
      .then((raw) => {
        ;(window as unknown as Record<string, unknown>).__evenBridge = { rawBridge: raw, onEvent: (h: (e: unknown) => void) => sdk.addEventListener(h) }
      })
      .catch(() => { /* mic bridge unavailable → startListen surfaces the error on-lens */ })

    // --- actions (mirror the old GlassActions, against store + hub) ---
    const openSession = async (id: string) => {
      // Point the home nav at this session's project, so 2-tap back from detail lands
      // on the owning project's sessions list (matters when opened from the interrupt).
      const gi = groupProjects(store.getState().sessions).findIndex((g) => g.sessions.some((y) => y.id === id))
      if (gi >= 0) navRef.current = { home: 'sessions', projIdx: gi }
      try {
        store.openDetail(id, (await getSession(id)).events)
        // Opening a session on the glasses = arm THIS session to park for steering.
        setSteerFocus(id).catch((e) => store.setGlassError(`focus failed: ${e}`))
      } catch (e) { store.setGlassError(`load failed: ${e}`) }
    }
    const closeSession = () => { store.closeDetail(); setSteerFocus(null).catch(() => { /* best-effort unfocus */ }) }
    const allow = (id: string) => { store.removeApproval(id); decide(id, 'allow').catch((e) => store.setGlassError(`allow failed: ${e}`)) }
    const deny = (id: string) => { store.removeApproval(id); decide(id, 'deny').catch((e) => store.setGlassError(`deny failed: ${e}`)) }
    // Answer a question by choosing a listed option. The answers map is keyed by the
    // EXACT question text so CC's schema validation passes (see the hook).
    const answerOption = (a: Approval, label: string) => {
      const q = firstQuestion(a)
      if (!q) return
      store.removeApproval(a.id)
      answer(a.id, { [q.text]: label }, label).catch((e) => store.setGlassError(`answer failed: ${e}`))
    }

    // --- voice answer (Phase 4b): even-toolkit STTEngine over the glasses mic ---
    // Created on demand when the user starts speaking, disposed when done/cancelled.
    let engine: STTEngine | null = null
    const disposeEngine = () => { try { engine?.dispose() } catch { /* ignore */ } engine = null }
    const startListen = async () => {
      const cfg = sttConfig()
      if (!cfg.enabled) { store.setGlassError('voice off — set an STT key'); return }
      if (store.getState().glassListening) return
      store.set({ glassListening: true, glassInterim: '' })
      try {
        engine = new STTEngine({ provider: cfg.provider, source: 'glass-bridge', apiKey: cfg.apiKey, language: cfg.language, mode: 'streaming', vad: true })
        engine.onTranscript((t) => { store.set({ glassInterim: t.text }); if (t.isFinal) { finalizeVoiceAnswer(t.text); disposeEngine() } })
        engine.onError((e) => { store.setGlassError(`stt: ${e.message}`); store.set({ glassListening: false, glassInterim: '' }); disposeEngine() })
        await engine.start()
      } catch (e) { store.set({ glassListening: false, glassInterim: '' }); store.setGlassError(`mic failed: ${e}`); disposeEngine() }
    }
    const submitListen = () => { const t = store.getState().glassInterim; try { engine?.stop() } catch { /* ignore */ } finalizeVoiceAnswer(t); disposeEngine() }
    const cancelListen = () => { try { engine?.abort() } catch { /* ignore */ } store.set({ glassListening: false, glassInterim: '' }); disposeEngine() }

    // --- voice steer (Phase 4c): same STT engine, but the final transcript is POSTed
    // to the focused session as a free-text steer rather than matched to an option. ---
    // A free-text steer is often several sentences with thinking pauses, so — unlike a
    // short voice answer — we do NOT auto-submit. VAD is off; the provider still emits a
    // `final` on each pause, so we ACCUMULATE those finals and only send on an explicit
    // tap. That makes pausing mid-thought safe (no premature submit).
    let steerAccum = ''
    const startSteer = async () => {
      const cfg = sttConfig()
      if (!cfg.enabled) { store.setGlassError('voice off — set an STT key'); return }
      if (store.getState().glassSteering) return
      steerAccum = ''
      store.set({ glassSteering: true, glassInterim: '' })
      try {
        engine = new STTEngine({ provider: cfg.provider, source: 'glass-bridge', apiKey: cfg.apiKey, language: cfg.language, mode: 'streaming', vad: false })
        engine.onTranscript((t) => {
          // final segments append to the running steer; interim shows as a live tail.
          const shown = t.isFinal ? (steerAccum = `${steerAccum} ${t.text}`.trim()) : `${steerAccum} ${t.text}`.trim()
          store.set({ glassInterim: shown })
        })
        engine.onError((e) => { store.setGlassError(`stt: ${e.message}`); store.set({ glassSteering: false, glassInterim: '' }); disposeEngine() })
        await engine.start()
      } catch (e) { store.set({ glassSteering: false, glassInterim: '' }); store.setGlassError(`mic failed: ${e}`); disposeEngine() }
    }
    const submitSteer = () => { try { engine?.stop() } catch { /* ignore */ } finalizeSteer(steerAccum || store.getState().glassInterim); disposeEngine() }
    const cancelSteer = () => { try { engine?.abort() } catch { /* ignore */ } steerAccum = ''; store.set({ glassSteering: false, glassInterim: '' }); disposeEngine() }

    // --- gesture routing (tap carries a row index on list/option screens) ---
    // Action debounce: on hardware a single physical tap can surface as two onTap
    // callbacks ~60-200ms apart (observed on-device). Where a tap toggles state — e.g.
    // detail: tap starts steering, a second tap then submits it — that double-fire flashes
    // the screen open→shut. No legitimate flow taps twice inside 400ms (a real double-tap
    // is a separate eventType:3 → onBack), so collapse rapid repeats.
    let lastTapAt = 0
    const onTap = (idx?: number) => {
      const nowMs = Date.now()
      if (nowMs - lastTapAt < 400) return
      lastTapAt = nowMs
      const s = glass(store.getState())
      switch (screenRef.current) {
        case 'projects': {
          // Drill into the tapped project's sessions (skip empty groups).
          const groups = groupProjects(s.sessions)
          if (typeof idx === 'number' && groups[idx]?.sessions.length) { navRef.current = { home: 'sessions', projIdx: idx }; render() }
          break
        }
        case 'sessions': { const r = typeof idx === 'number' ? rowsRef.current[idx] : undefined; if (r?.id) openSession(r.id); break }
        case 'approval': { const a = gates(s)[0]; if (a) allow(a.id); break }
        case 'question': {
          if (s.listening) { submitListen(); break }   // tap while listening = submit now
          const a = questions(s)[0]; const r = typeof idx === 'number' ? rowsRef.current[idx] : undefined
          if (!a || !r) break
          if (r.id === SPEAK) startListen(); else answerOption(a, r.id)
          break
        }
        case 'detail': {
          if (s.steering) { submitSteer(); break }   // tap while steering = send now
          startSteer()                                // tap on detail = dictate a steer (self-guards on STT)
          break
        }
        case 'interrupt': { const a = attentionSessions(s)[0]; if (a) { store.dismissInterrupt(intrKey(store.getState())); openSession(a.id) } break }
      }
    }
    const onBack = () => {
      const s = glass(store.getState())
      switch (screenRef.current) {
        case 'projects': break // home — nowhere further back
        case 'sessions': { navRef.current = { home: 'projects', projIdx: navRef.current.projIdx }; render(); break } // back to projects home
        case 'detail': { if (s.steering) { cancelSteer(); break } closeSession(); break } // 2tap: stop steering, else leave
        case 'approval': { const a = gates(s)[0]; if (a) deny(a.id); break }
        case 'question': {
          if (s.listening) { cancelListen(); break }   // 2tap while listening = stop, keep the question
          const a = questions(s)[0]; if (a) deny(a.id); break // 2tap = cancel the question
        }
        case 'interrupt': store.dismissInterrupt(intrKey(store.getState())); break
      }
    }

    // A hardware double-tap arrives as a single-click event FOLLOWED by an
    // eventType-3 event. Debounce so a 2-tap doesn't also fire the single-tap
    // action: hold the tap ~280ms; a double-click within that window cancels it.
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    let pendingIdx: number | undefined
    // We track the selected row ourselves from scroll events, because on real hardware
    // a click doesn't reliably carry `currentSelectItemIndex` (it can arrive as a
    // text/sys click with no index). Reset to 0 on each screen/content change (render).
    let selIdx = 0
    const CLICK_DELAY = 280
    const onEvent = (event: unknown) => {
      const e = event as Record<string, any>
      if (e?.audioEvent) return // PCM chunks belong to STT, not gesture routing
      const le = e?.listEvent, te = e?.textEvent, se = e?.sysEvent
      const et = le?.eventType ?? te?.eventType ?? se?.eventType
      if (et === 3) { if (tapTimer) { clearTimeout(tapTimer); tapTimer = null } return onBack() }
      const nRows = rowsRef.current.length || 1
      // On the detail screen a scroll pages through the latest reply; elsewhere it
      // moves the native list selection.
      if (et === 1) { if (screenRef.current === 'detail') { pageDetail(-1); return } selIdx = Math.max(0, selIdx - 1); return } // scroll up
      if (et === 2) { if (screenRef.current === 'detail') { pageDetail(1); return } selIdx = Math.min(nRows - 1, selIdx + 1); return } // scroll down
      // Single click: prefer the firmware's row index; fall back to our tracked one.
      pendingIdx = le && typeof le.currentSelectItemIndex === 'number' ? le.currentSelectItemIndex : selIdx
      if (tapTimer) clearTimeout(tapTimer)
      tapTimer = setTimeout(() => { tapTimer = null; onTap(pendingIdx) }, CLICK_DELAY)
    }
    sdk.addEventListener(onEvent)

    // --- render loop: rebuild the page when the display signature changes ---
    const render = () => {
      const s = glass(store.getState())
      const nav = navRef.current
      const groups = groupProjects(s.sessions)
      // A drilled-into project can vanish (session ended, list refreshed) — fall home.
      if (nav.home === 'sessions' && !groups[nav.projIdx]) { nav.home = 'projects'; nav.projIdx = 0 }
      const scr = pickScreen(s, nav)
      const sig = signature(s, scr, nav, groups)
      if (sig === sigRef.current) return
      sigRef.current = sig
      selIdx = 0 // new screen/content → firmware selection resets to the top; mirror it
      screenRef.current = scr
      buildAndRender(sdk, scr, s, nav, groups, rowsRef).catch((err) => store.setGlassError(`render failed: ${err}`))
    }

    render()
    // The interrupt hero's Even icon sprite rasterises async; force one re-render
    // when it's ready so the first interrupt shows the real bell, not the fallback.
    iconReady.finally(() => { sigRef.current = ''; render() })
    const unsub = store.subscribe(render)
    return () => { if (tapTimer) clearTimeout(tapTimer); unsub(); sdk.removeEventListener(onEvent); disposeEngine() }
  }, [])

  return null
}

// Snapshot view of the store, matching GlassSnapshot shape used by the screens.
function glass(st: ReturnType<typeof store.getState>): GlassSnapshot {
  return {
    connection: st.connection, armed: st.armed, sessions: st.sessions,
    approvals: st.approvals, activeSessionId: st.activeSessionId,
    activeEvents: st.activeEvents, detailPage: st.detailPage, error: st.glassError,
    dismissedAttentionKey: st.dismissedAttentionKey,
    listening: st.glassListening, steering: st.glassSteering, interim: st.glassInterim,
    pendingSteer: st.glassPendingSteer,
  }
}
function intrKey(st: ReturnType<typeof store.getState>): string {
  return attentionSessions(glass(st)).map((a) => a.id).sort().join(',')
}

// Compose the page for the active screen and push it to the glasses.
async function buildAndRender(
  sdk: GlassesSdk, scr: Screen, s: GlassSnapshot, nav: Nav, groups: ProjGroup[],
  rowsRef: { current: { id: string; label: string }[] },
) {
  // The interrupt is a bitmap hero — GlassesPage composes text+list only, so it's
  // rendered directly via the raw bridge (image containers + an event-capture overlay).
  if (scr === 'interrupt') { rowsRef.current = []; return renderInterrupt(s) }

  const page = sdk.createPage(`cockpit-${scr}`)

  if (scr === 'projects') {
    // Home: the projects list. Minimal-border design — the ONLY border is the native
    // select-highlight the firmware moves on-device. Each row: badge · name · meta.
    const rows = groups.length
      ? groups.map((g) => {
          const needs = g.sessions.some((x) => x.needsAttention)
          const meta = needs ? 'needs you' : g.asst ? `${g.sessions.length} chats` : `${g.sessions.length}`
          return { id: g.key, label: `${g.badge}   ${g.name}   ·   ${meta}` }
        })
      : [{ id: '', label: s.connection === 'ok' ? '(no active sessions)' : s.connection === 'error' ? '(disconnected)' : '(connecting…)' }]
    rowsRef.current = rows
    const list = page.addListElement(rows.map((r) => r.label))
    list.setItemWidth(536)
    list.setIsItemSelectBorderEn(true)
    list.markAsEventCaptureElement()
    list.setPosition((p) => { p.setX(18).setY(12) })
    list.setSize((z) => { z.setWidth(540).setHeight(264) })
  } else if (scr === 'sessions') {
    // A project's sessions. Left = a bare letter rail (› marks the current project);
    // right = the session list. Still no frames but the native select-highlight.
    const railX = 10, railW = 48, railY = 12
    const rail = page.addTextElement(groups.map((g, i) => `${i === nav.projIdx ? '›' : ' '} ${g.badge}`).join('\n\n'))
    rail.setPosition((p) => { p.setX(railX).setY(railY) })
    rail.setSize((z) => { z.setWidth(railW).setHeight(264) })

    const sessions = groups[nav.projIdx]?.sessions ?? []
    const rows = sessions.length ? sessions.map(sessionRow) : [{ id: '', label: '(no active sessions)' }]
    rowsRef.current = rows
    const listX = railX + railW + 12
    const list = page.addListElement(rows.map((r) => r.label))
    list.setItemWidth(576 - listX - 22)
    list.setIsItemSelectBorderEn(true)
    list.markAsEventCaptureElement()
    list.setPosition((p) => { p.setX(listX).setY(10) })
    list.setSize((z) => { z.setWidth(576 - listX - 14).setHeight(268) })
  } else if (scr === 'approval') {
    // The hero actionable screen: what · where · then decide. Nothing auto-fires —
    // ● = tap (Allow), ●● = double-tap (Deny), opposite gestures for opposite outcomes.
    rowsRef.current = []
    const card = page.addTextElement(approvalContent(s))
    card.setBorder((b) => b.setWidth(2).setColor(BORDER).setRadius(14))
    card.markAsEventCaptureElement()
    card.setPosition((p) => { p.setX(40).setY(44) })
    card.setSize((z) => { z.setWidth(496).setHeight(200) })
  } else if (scr === 'question') {
    // AskUserQuestion. Two sub-views:
    //  • listening — mic open, live interim transcript, tap=submit / 2tap=cancel.
    //  • idle — prompt on a left rail; options (plus a leading "Speak answer" row when
    //    voice is configured) as a native selectable list; scroll moves the selection,
    //    tap answers with that option, 2tap cancels the question.
    const a = questions(s)[0]
    const q = a && firstQuestion(a)
    if (s.listening) {
      rowsRef.current = []
      const heard = s.error ? `! ${s.error}` : s.interim ? `“${s.interim}”` : '(listening…)'
      const card = page.addTextElement(`● LISTENING…\n\n${q ? q.text : ''}\n\n${heard}\n\ntap ● submit   ●● cancel`)
      card.setBorder((b) => b.setWidth(2).setColor(BORDER).setRadius(14))
      card.markAsEventCaptureElement()
      card.setPosition((p) => { p.setX(24).setY(20) })
      card.setSize((z) => { z.setWidth(528).setHeight(248) })
    } else {
      // Surface a transient error (e.g. a mic failure) on the rail so it's visible on-lens.
      const err = s.error ? `\n\n! ${s.error}` : ''
      const rail = page.addTextElement(`● QUESTION\n\n${q ? q.text : '(no question)'}${err}`)
      rail.setPosition((p) => { p.setX(10).setY(20) })
      rail.setSize((z) => { z.setWidth(214).setHeight(248) })

      const opts = q && q.options.length ? q.options : ['(no options)']
      const rows = opts.map((label) => ({ id: label, label: `› ${label}` }))
      // Voice affordance as the first row (tap it to start speaking) when STT is set up.
      if (sttConfig().enabled) rows.unshift({ id: SPEAK, label: '● Speak answer' })
      rowsRef.current = rows
      const list = page.addListElement(rows.map((r) => r.label))
      list.setItemWidth(320)
      list.setIsItemSelectBorderEn(true)
      list.setBorder((b) => b.setWidth(2).setColor(BORDER).setRadius(14))
      list.markAsEventCaptureElement()
      list.setPosition((p) => { p.setX(236).setY(20) })
      list.setSize((z) => { z.setWidth(330).setHeight(248) })
    }
  } else {
    // detail = the focused session, in the locked header-bar layout:
    //   • header bar (the ONE deliberate border): session name left, page k/N inline.
    //   • controls right-aligned in their own element (firmware text is left-aligned,
    //     so measure with pretext/LVGL metrics and place flush to the right edge).
    //   • frameless reply body below — the event-capture element, so scroll pages the
    //     REPLY, not the header. Two sub-views: steering (mic) vs the paged reply.
    rowsRef.current = []
    const sess = s.sessions.find((x) => x.id === s.activeSessionId)
    const title = sess?.title || sess?.project || 'session'
    const hx = 8, hy = 8, hw = 560, hh = 36
    let headerText: string, hint: string, bodyText: string
    if (s.steering) {
      headerText = `‹ ${String(title).slice(0, 30)}`
      hint = '• send   •• cancel'
      bodyText = s.error ? `! ${s.error}` : s.interim ? `“${s.interim}”` : '(speak your steer…)'
    } else if (s.pendingSteer && latestReplyText(s.activeEvents) === s.pendingSteer.baseReply) {
      // A steer was just sent and the agent hasn't replied yet — echo what you said,
      // so it shows in the session view before the response. Gives way to the reply
      // the moment a newer assistant message lands (latestReply diverges from baseReply).
      headerText = `‹ ${String(title).slice(0, 30)}`
      hint = '• steer   •• back'
      const wrapped = paginateText(`you › ${s.pendingSteer.text}`, DETAIL_COLS, DETAIL_ROWS)[0].join('\n')
      bodyText = s.error ? `${wrapped}\n! ${s.error}` : `${wrapped}\n\n(sent — working…)`
    } else {
      const pages = replyPages(s.activeEvents)
      const total = Math.max(1, pages.length)
      const pg = Math.min(Math.max(0, s.detailPage), total - 1)
      headerText = `‹ ${String(title).slice(0, 26)}${pages.length > 1 ? `   ${pg + 1}/${total}` : ''}`
      hint = '• steer   •• back'
      if (pages.length === 0) {
        const status = sess?.live ? '(working — no reply yet)' : '(no reply yet)'
        bodyText = s.error ? `${status}\n! ${s.error}` : status
      } else {
        bodyText = s.error ? `${pages[pg]}\n! ${s.error}` : pages[pg]
      }
    }
    const header = page.addTextElement(headerText)
    header.setBorder((b) => b.setWidth(2).setColor(BORDER).setRadius(10))
    header.setPosition((p) => { p.setX(hx).setY(hy) })
    header.setSize((z) => { z.setWidth(hw).setHeight(hh) })
    const hintW = Math.ceil(getTextWidth(hint))
    const right = page.addTextElement(hint)
    right.setPosition((p) => { p.setX(hx + hw - hintW - 22).setY(hy + 6) })
    right.setSize((z) => { z.setWidth(hintW + 18).setHeight(hh - 10) })
    const bodyY = hy + hh + 10
    const body = page.addTextElement(bodyText)
    body.markAsEventCaptureElement()
    body.setPosition((p) => { p.setX(hx + 4).setY(bodyY) })
    body.setSize((z) => { z.setWidth(hw - 8).setHeight(288 - bodyY - 8) })
  }

  await page.render()
}

// Interrupt hero: rendered outside GlassesPage (which has no image element) —
// a full-screen event-capture overlay + the 3 hero image tiles, pushed via the
// raw bridge. Mirrors even-toolkit's showHomePage recipe (overlay id 1, tiles 2-4).
async function renderInterrupt(s: GlassSnapshot) {
  const raw = await GlassesSdk.getRawBridge()
  const a = attentionSessions(s)[0]
  const name = a ? a.title || a.project || a.id.slice(0, 8) : 'session'
  const tiles = renderInterruptHero(name, a ? reason(a) : '')

  const overlay = new TextContainerProperty({
    containerID: 1, containerName: 'overlay',
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 0, paddingLength: 0, content: '', isEventCapture: 1,
  })
  const imageObject = tiles.map((t) => new ImageContainerProperty({
    containerID: t.id, containerName: t.name,
    xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
  }))
  const fields = { containerTotalNum: 1 + tiles.length, textObject: [overlay], imageObject }

  // GlassesSdk tracks the current page in shared global state; honour create-vs-rebuild
  // and keep it in sync so the next GlassesPage render rebuilds cleanly.
  const shared = (globalThis as Record<string, any>).__glassesToolkitSharedState
  if (!shared || shared.currentPageId == null) await raw.createStartUpPageContainer(new CreateStartUpPageContainer(fields))
  else await raw.rebuildPageContainer(new RebuildPageContainer(fields))
  if (shared) shared.currentPageId = 'cockpit-interrupt'

  for (const t of tiles) {
    await raw.updateImageRawData(new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: t.bytes }))
  }
}

// The approval card body. Acts on approvals[0]; when several are queued the count
// shows and the next pops up after each decision (no cycling needed).
function approvalContent(s: GlassSnapshot): string {
  const g = gates(s)
  const a = g[0]
  if (!a) return '● APPROVE\n\n(nothing pending)'
  const inp = (a.tool_input ?? {}) as Record<string, unknown>
  const cmd = typeof inp.command === 'string' ? inp.command
    : typeof inp.file_path === 'string' ? inp.file_path
    : a.title
  const tool = (a.tool_name || 'tool').toUpperCase()
  const proj = a.cwd.split('/').pop() || a.cwd
  const counter = g.length > 1 ? ` · ${g.length} pending` : ''
  return `● APPROVE${counter}\n\n${tool} · ${proj}\n› ${String(cmd).slice(0, 120)}\n\n● Allow      ●● Deny`
}

// Detail card = the latest assistant reply, paginated so the WHOLE reply is
// readable on the ~10-line HUD (the old single-render budget hard-capped it at
// ~420 chars with no scroll); DETAIL_ROWS fits a page with room for the header.
// 50 cols fills ~92% of the full-width body element (measured via pretext/LVGL
// metrics: 42 cols only reached ~75%, hence the reply looked two-thirds wide),
// with headroom so a wide line doesn't overflow into a firmware re-wrap.
const DETAIL_COLS = 50
const DETAIL_ROWS = 7

/** Text of the most recent non-empty assistant message (the "latest reply"). */
function latestReplyText(events: TranscriptEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].kind === 'assistant_text') {
      const t = (events[i].text ?? '').trim()
      if (t) return t
    }
  }
  return ''
}

/** The latest reply split into card-sized pages (each a ready-to-render block). */
function replyPages(events: TranscriptEvent[]): string[] {
  const text = latestReplyText(events)
  if (!text) return []
  return paginateText(text, DETAIL_COLS, DETAIL_ROWS).map((lines) => lines.join('\n'))
}
