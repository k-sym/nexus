// Phase 3 LIVE PROTOTYPE — the approved bitmap design made navigable, driven by
// fixture data, so we can drive the sim (scroll/tap/back) and screenshot the real
// drill-down: projects → sessions (rail + list) → detail. Reuses the canvas
// primitives from Lab.tsx. This is the precursor to the real renderer; once the
// interaction is signed off it gets wired to live gateway data in place of DATA.
import { useEffect, useRef } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'
import {
  roundRect, badge, bell, statusMark, chevron, text, pushFullScreen,
  W, H, FG, FG2, DIM, FAINT, STROKE, type Draw,
} from './Lab'

type Status = 'live' | 'needs' | 'idle'
interface Session { icon: Status; title: string; meta: string; reply: string }
interface Project { g: string; name: string; asst?: boolean; sessions: Session[] }

const R1 =
  'I wired the QuestionBroker to push pending and resolved events the instant a ' +
  'question registers, then dropped the one-second poll timer. The session list now ' +
  'lights up the moment a session needs input. On the glasses side the detail card ' +
  'shows the latest reply in full, paginated, and scroll pages through it.'
const R2 = 'Grouping sessions under their project now, with the badge rail for navigation. Home is a clean projects list.'
const R3 = 'Rebuilt the embedder ubatch chunk limit and re-ran the backfill; all green.'

const DATA: Project[] = [
  { g: 'N', name: 'nexus', sessions: [
    { icon: 'needs', title: 'glasses gateway', meta: 'needs you', reply: R1 },
    { icon: 'live', title: 'phase-3 grouping', meta: '2m', reply: R2 },
    { icon: 'live', title: 'memory daemon', meta: '14m', reply: R3 },
    { icon: 'idle', title: 'jira sync', meta: '3h', reply: 'Synced 42 issues; nothing pending.' },
  ] },
  { g: 'B', name: 'baker-internal', sessions: [
    { icon: 'needs', title: 'billing export', meta: 'needs you', reply: 'Which date range should the export cover?' },
    { icon: 'idle', title: 'api cleanup', meta: '1h', reply: 'Removed the dead routes.' },
  ] },
  { g: 'M', name: 'mission-control', sessions: [
    { icon: 'live', title: 'triage sweep', meta: '5m', reply: 'Working through the inbox.' },
  ] },
  { g: 'D', name: 'docs-site', sessions: [] },
  { g: '✳', name: 'Assistant', asst: true, sessions: [
    { icon: 'live', title: 'morning brief', meta: '20m', reply: 'Consumer sentiment ticked up to 48.9 after four months of decline.' },
    { icon: 'idle', title: 'travel plan', meta: '2h', reply: 'Booked the 9am; hotel confirmed.' },
  ] },
]

const needsCount = (p: Project) => p.sessions.filter((s) => s.icon === 'needs').length

// ── screen draws (data-driven, selection-aware) ─────────────────────────────
function drawProjects(sel: number): Draw {
  return (ctx) => {
    const top = 12, rh = (H - top - 6) / DATA.length
    DATA.forEach((p, i) => {
      const cy = top + rh * i + rh / 2
      const bs = 42
      badge(ctx, 22, cy - bs / 2, bs, p.g, i === sel, p.asst ? 26 : 22)
      text(ctx, p.name, 22 + bs + 18, cy, 24, i === sel ? FG : FG2, i === sel ? 700 : 600)
      if (needsCount(p) > 0) { bell(ctx, W - 128, cy, 20); text(ctx, 'needs you', W - 112, cy, 17, FG, 700) }
      else text(ctx, p.asst ? `${p.sessions.length} chats` : `${p.sessions.length}`, W - 34, cy, 18, DIM, 600, 'right')
    })
  }
}

function drawSessions(projIdx: number, sel: number): Draw {
  return (ctx) => {
    const bs = 40, railX = 18, gap = 8
    const totalH = DATA.length * bs + (DATA.length - 1) * gap
    let by = (H - totalH) / 2
    const centres: number[] = []
    DATA.forEach((p, i) => { badge(ctx, railX, by, bs, p.g, i === projIdx, p.asst ? 24 : 20); centres.push(by + bs / 2); by += bs + gap })

    const cardX = railX + bs + 22, cardY = 10, cardW = W - cardX - 14, cardH = H - 20
    ctx.lineWidth = 2.4; ctx.strokeStyle = STROKE; roundRect(ctx, cardX, cardY, cardW, cardH, 16); ctx.stroke()
    ctx.strokeStyle = FG; ctx.lineWidth = 2.4; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(railX + bs + 2, centres[projIdx]); ctx.lineTo(cardX, centres[projIdx]); ctx.stroke()

    const sessions = DATA[projIdx].sessions
    if (sessions.length === 0) { text(ctx, 'no active sessions', cardX + cardW / 2, cardY + cardH / 2, 22, DIM, 600, 'center'); return }
    const innerTop = cardY + 12, rh = (cardH - 24) / Math.max(sessions.length, 1)
    sessions.forEach((s, i) => {
      const cy = innerTop + rh * i + rh / 2
      if (i === sel) { ctx.fillStyle = '#1c1c1c'; roundRect(ctx, cardX + 8, cy - rh / 2 + 3, cardW - 16, rh - 6, 12); ctx.fill()
        ctx.strokeStyle = FG; ctx.lineWidth = 2; roundRect(ctx, cardX + 8, cy - rh / 2 + 3, cardW - 16, rh - 6, 12); ctx.stroke() }
      statusMark(ctx, cardX + 30, cy, s.icon, 10)
      const bright = s.icon !== 'idle' || i === sel
      text(ctx, s.title, cardX + 54, cy, 23, bright ? FG : FG2, s.icon === 'needs' ? 700 : 600)
      text(ctx, s.meta, cardX + cardW - 16, cy, 17, s.icon === 'needs' ? FG : DIM, 600, 'right')
    })
  }
}

// Canvas word-wrap to a pixel width (pretty, measured — not char-counted).
function wrapCanvas(ctx: CanvasRenderingContext2D, s: string, maxW: number, px: number, weight = 600): string[] {
  ctx.font = `${weight} ${px}px system-ui, -apple-system, sans-serif`
  const words = s.split(/\s+/); const lines: string[] = []; let cur = ''
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w
    if (ctx.measureText(t).width <= maxW) cur = t
    else { if (cur) lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

function drawDetail(projIdx: number, sessIdx: number, page: number, pagesOut: (n: number) => void): Draw {
  return (ctx) => {
    const s = DATA[projIdx].sessions[sessIdx]
    const pad = 26, maxW = W - pad * 2, bodyPx = 24, lineH = 32, rows = 5
    const all = wrapCanvas(ctx, s.reply, maxW, bodyPx)
    const pages = Math.max(1, Math.ceil(all.length / rows))
    pagesOut(pages)
    const p = Math.min(Math.max(0, page), pages - 1)
    // header
    chevron(ctx, pad + 6, 26, 9, 'left')
    text(ctx, s.title, pad + 26, 26, 22, FG, 700)
    if (pages > 1) text(ctx, `${p + 1}/${pages}`, W - pad, 26, 18, DIM, 600, 'right')
    ctx.strokeStyle = FAINT; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, 46); ctx.lineTo(W - pad, 46); ctx.stroke()
    // body page
    const slice = all.slice(p * rows, p * rows + rows)
    slice.forEach((ln, i) => text(ctx, ln, pad, 70 + i * lineH, bodyPx, FG2, 500))
    // hint
    text(ctx, pages > 1 ? 'scroll page · ● steer · ●● back' : '● steer · ●● back', pad, H - 16, 15, DIM, 600)
  }
}

// ── nav controller ──────────────────────────────────────────────────────────
type Screen = 'projects' | 'sessions' | 'detail'
interface Nav { screen: Screen; proj: number; sess: number; page: number }

export function Phase3App() {
  const nav = useRef<Nav>({ screen: 'projects', proj: 0, sess: 0, page: 0 })
  const detailPages = useRef(1)
  const sigRef = useRef('')

  useEffect(() => {
    const sdk = new GlassesSdk()
    // mic bridge shape (not used here, but keep the toolkit happy)
    GlassesSdk.getRawBridge().then((raw) => {
      ;(window as unknown as Record<string, unknown>).__evenBridge = { rawBridge: raw, onEvent: (h: (e: unknown) => void) => sdk.addEventListener(h) }
    }).catch(() => {})

    const render = () => {
      const n = nav.current
      let draw: Draw
      if (n.screen === 'projects') draw = drawProjects(n.proj)
      else if (n.screen === 'sessions') draw = drawSessions(n.proj, n.sess)
      else draw = drawDetail(n.proj, n.sess, n.page, (p) => { detailPages.current = p })
      const sig = `${n.screen}|${n.proj}|${n.sess}|${n.page}`
      if (sig === sigRef.current) return
      sigRef.current = sig
      pushFullScreen(draw).catch((e) => console.error('[p3] render failed', e))
    }

    const move = (delta: number) => {
      const n = nav.current
      if (n.screen === 'projects') n.proj = clamp(n.proj + delta, 0, DATA.length - 1)
      else if (n.screen === 'sessions') n.sess = clamp(n.sess + delta, 0, Math.max(0, DATA[n.proj].sessions.length - 1))
      else n.page = clamp(n.page + delta, 0, detailPages.current - 1)
      render()
    }
    const enter = () => {
      const n = nav.current
      if (n.screen === 'projects') { if (DATA[n.proj].sessions.length) { n.screen = 'sessions'; n.sess = 0 } }
      else if (n.screen === 'sessions') { if (DATA[n.proj].sessions.length) { n.screen = 'detail'; n.page = 0 } }
      render()
    }
    const back = () => {
      const n = nav.current
      if (n.screen === 'detail') n.screen = 'sessions'
      else if (n.screen === 'sessions') n.screen = 'projects'
      render()
    }

    // gesture routing (mirror AppGlasses3c: 1=up 2=down 3=back, single-click=enter)
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    const onEvent = (event: unknown) => {
      const e = event as Record<string, any>
      if (e?.audioEvent) return
      const et = e?.listEvent?.eventType ?? e?.textEvent?.eventType ?? e?.sysEvent?.eventType
      if (et === 3) { if (tapTimer) { clearTimeout(tapTimer); tapTimer = null } return back() }
      if (et === 1) return move(-1)
      if (et === 2) return move(1)
      if (tapTimer) clearTimeout(tapTimer)
      tapTimer = setTimeout(() => { tapTimer = null; enter() }, 260)
    }
    sdk.addEventListener(onEvent)
    render()
    return () => { if (tapTimer) clearTimeout(tapTimer); sdk.removeEventListener(onEvent) }
  }, [])
  return null
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
