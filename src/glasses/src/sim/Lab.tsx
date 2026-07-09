// Phase 3 DESIGN LAB — full-screen bitmap mockups pushed to the G2 lens, one per
// `?sim=lab-<name>`. These are pure-canvas designs (like hero.ts, but full 576×288)
// so we can iterate on the *look* and screenshot real HUD output before wiring any
// of it to the store/renderer. The lens is 16-level greyscale, so we draw in
// white/greys and the display tints it green.
//
// Not shipped in production: lazy-imported only when App sees `?sim=lab-*`.
import { useEffect } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'
import {
  CreateStartUpPageContainer, RebuildPageContainer,
  TextContainerProperty, ImageContainerProperty, ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'
import { encodeTilesBatch } from 'even-toolkit/png-utils'

const W = 576, H = 288

// Greyscale palette (green comes from the lens). Brighter grey = brighter green.
const FG = '#ffffff'    // primary
const FG2 = '#d0d0d0'   // secondary
const DIM = '#8c8c8c'   // meta / labels
const FAINT = '#3c3c3c' // dimmed background context
const STROKE = '#c4c4c4'

type Draw = (ctx: CanvasRenderingContext2D) => void

// ── canvas helpers ──────────────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// A rounded letter/glyph badge (like Nexus's project rail). Filled when selected.
function badge(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, glyph: string, selected: boolean, glyphPx = 22) {
  ctx.lineWidth = 2.4
  ctx.strokeStyle = STROKE
  roundRect(ctx, x, y, s, s, Math.round(s * 0.28))
  if (selected) { ctx.fillStyle = FG; ctx.fill() } else { ctx.stroke() }
  ctx.fillStyle = selected ? '#000' : FG
  ctx.font = `700 ${glyphPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(glyph, x + s / 2, y + s / 2 + 1)
}

// A clean notification bell centred on (cx, cy) (used for "needs you").
function bell(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save()
  ctx.strokeStyle = FG; ctx.fillStyle = FG
  ctx.lineWidth = Math.max(1.6, s * 0.09)
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  const top = cy - s * 0.42, bottom = cy + s * 0.34
  const halfTop = s * 0.16, halfBot = s * 0.42
  ctx.beginPath(); ctx.arc(cx, top - s * 0.12, s * 0.08, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath()
  ctx.moveTo(cx - halfBot, bottom)
  ctx.quadraticCurveTo(cx - halfBot, bottom - s * 0.42, cx - halfTop, top + s * 0.18)
  ctx.quadraticCurveTo(cx - halfTop, top, cx, top)
  ctx.quadraticCurveTo(cx + halfTop, top, cx + halfTop, top + s * 0.18)
  ctx.quadraticCurveTo(cx + halfBot, bottom - s * 0.42, cx + halfBot, bottom)
  ctx.stroke()
  ctx.beginPath(); ctx.moveTo(cx - halfBot - 2, bottom); ctx.lineTo(cx + halfBot + 2, bottom); ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, bottom + s * 0.14, s * 0.1, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

// Status marks — candidates to replace ●◐○.
//  live  = filled disc + orbit ring (a "running" feel)
//  needs = bell
//  idle  = hollow ring
function statusMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, kind: 'live' | 'needs' | 'idle', r = 9) {
  ctx.save()
  if (kind === 'needs') { bell(ctx, cx, cy, r * 2.2); ctx.restore(); return }
  ctx.lineWidth = 2
  ctx.strokeStyle = FG; ctx.fillStyle = FG
  if (kind === 'live') {
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI * 0.15, Math.PI * 1.15); ctx.stroke()
  } else { // idle
    ctx.strokeStyle = DIM
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke()
  }
  ctx.restore()
}

function chevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, dir: 'left' | 'right' | 'up' | 'down') {
  ctx.save(); ctx.strokeStyle = FG; ctx.lineWidth = 2.4; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  ctx.beginPath()
  if (dir === 'left') { ctx.moveTo(cx + s / 2, cy - s); ctx.lineTo(cx - s / 2, cy); ctx.lineTo(cx + s / 2, cy + s) }
  else if (dir === 'right') { ctx.moveTo(cx - s / 2, cy - s); ctx.lineTo(cx + s / 2, cy); ctx.lineTo(cx - s / 2, cy + s) }
  else if (dir === 'up') { ctx.moveTo(cx - s, cy + s / 2); ctx.lineTo(cx, cy - s / 2); ctx.lineTo(cx + s, cy + s / 2) }
  else { ctx.moveTo(cx - s, cy - s / 2); ctx.lineTo(cx, cy + s / 2); ctx.lineTo(cx + s, cy - s / 2) }
  ctx.stroke(); ctx.restore()
}

function waveform(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save(); ctx.strokeStyle = FG; ctx.lineWidth = 3; ctx.lineCap = 'round'
  const bars = 22, gap = w / bars
  // A static but organic-looking envelope (louder in the middle).
  const amp = [3, 5, 8, 6, 11, 16, 9, 20, 13, 24, 18, 26, 17, 23, 12, 19, 10, 14, 7, 9, 5, 3]
  for (let i = 0; i < bars; i++) {
    const bx = x + i * gap + gap / 2
    const bh = Math.min(h, amp[i] ?? 4)
    ctx.beginPath(); ctx.moveTo(bx, y + h / 2 - bh / 2); ctx.lineTo(bx, y + h / 2 + bh / 2); ctx.stroke()
  }
  ctx.restore()
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color: string, weight = 600, align: CanvasTextAlign = 'left') {
  ctx.fillStyle = color
  ctx.font = `${weight} ${px}px system-ui, -apple-system, 'Segoe UI', sans-serif`
  ctx.textAlign = align; ctx.textBaseline = 'middle'
  ctx.fillText(s, x, y)
}

// ── MOCKUP 1: projects home (clean list, letter badges, no count rail) ──────
function drawProjectsHome(ctx: CanvasRenderingContext2D) {
  const rows = [
    { g: 'N', name: 'nexus', count: 3, sel: true, needs: false },
    { g: 'B', name: 'baker-internal', count: 2, sel: false, needs: true },
    { g: 'M', name: 'mission-control', count: 1, sel: false, needs: false },
    { g: 'D', name: 'docs-site', count: 0, sel: false, needs: false },
    { g: '✳', name: 'Assistant', count: 2, sel: false, needs: false, asst: true },
  ]
  const top = 12, rh = (H - top - 6) / rows.length
  rows.forEach((r, i) => {
    const cy = top + rh * i + rh / 2
    const bs = 42
    badge(ctx, 22, cy - bs / 2, bs, r.g, r.sel, r.asst ? 26 : 22)
    text(ctx, r.name, 22 + bs + 18, cy, 24, r.sel ? FG : FG2, r.sel ? 700 : 600)
    if (r.needs) {
      bell(ctx, W - 128, cy, 20)
      text(ctx, 'needs you', W - 112, cy, 17, FG, 700)
    } else {
      text(ctx, r.asst ? `${r.count} chats` : `${r.count}`, W - 34, cy, 18, DIM, 600, 'right')
    }
  })
}

// ── MOCKUP 2: sessions in a project (one.jpg — badge rail + list) ───────────
function drawSessions(ctx: CanvasRenderingContext2D) {
  const rail = ['N', 'B', 'M', 'D', '✳']
  const selIdx = 0
  const bs = 40, railX = 18, gap = 8
  const totalH = rail.length * bs + (rail.length - 1) * gap
  let by = (H - totalH) / 2
  const centres: number[] = []
  rail.forEach((g, i) => {
    badge(ctx, railX, by, bs, g, i === selIdx, g === '✳' ? 24 : 20)
    centres.push(by + bs / 2)
    by += bs + gap
  })

  // list card
  const cardX = railX + bs + 22, cardY = 10, cardW = W - cardX - 14, cardH = H - 20
  ctx.lineWidth = 2.4; ctx.strokeStyle = STROKE
  roundRect(ctx, cardX, cardY, cardW, cardH, 16); ctx.stroke()

  // connector from the selected badge into the card (one.jpg bracket)
  ctx.strokeStyle = FG; ctx.lineWidth = 2.4; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(railX + bs + 2, centres[selIdx]); ctx.lineTo(cardX, centres[selIdx]); ctx.stroke()

  const sessions = [
    { icon: 'needs' as const, title: 'glasses gateway', meta: 'needs you' },
    { icon: 'live' as const, title: 'phase-3 grouping', meta: '2m' },
    { icon: 'live' as const, title: 'memory daemon', meta: '14m' },
    { icon: 'idle' as const, title: 'jira sync', meta: '3h' },
  ]
  const innerTop = cardY + 12, rh = (cardH - 24) / sessions.length
  sessions.forEach((s, i) => {
    const cy = innerTop + rh * i + rh / 2
    if (i > 0) { ctx.strokeStyle = FAINT; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cardX + 14, innerTop + rh * i); ctx.lineTo(cardX + cardW - 14, innerTop + rh * i); ctx.stroke() }
    statusMark(ctx, cardX + 28, cy, s.icon, 10)
    const bright = s.icon !== 'idle'
    text(ctx, s.title, cardX + 52, cy, 23, bright ? FG : FG2, s.icon === 'needs' ? 700 : 600)
    text(ctx, s.meta, cardX + cardW - 16, cy, 17, s.icon === 'needs' ? FG : DIM, 600, 'right')
  })
}

// ── MOCKUP 3: voice-input overlay (two.png — "AI Listening" bar) ────────────
function drawListening(ctx: CanvasRenderingContext2D) {
  // faint background context (a session list, dimmed)
  const ctxRows = ['glasses gateway', 'phase-3 grouping', 'memory daemon', 'jira sync']
  ctxRows.forEach((t, i) => text(ctx, t, 40, 44 + i * 40, 22, FAINT, 600))
  ctx.strokeStyle = FAINT; ctx.lineWidth = 2; roundRect(ctx, 20, 18, W - 40, H - 36, 16); ctx.stroke()

  // the listening pill
  const pw = W - 96, ph = 74, px = (W - pw) / 2, py = (H - ph) / 2
  ctx.fillStyle = '#000'; roundRect(ctx, px, py, pw, ph, ph / 2); ctx.fill()
  ctx.strokeStyle = FG; ctx.lineWidth = 2.6; roundRect(ctx, px, py, pw, ph, ph / 2); ctx.stroke()
  // live dot + label
  ctx.fillStyle = FG; ctx.beginPath(); ctx.arc(px + 40, py + ph / 2, 7, 0, Math.PI * 2); ctx.fill()
  text(ctx, 'Listening…', px + 60, py + ph / 2, 24, FG, 700)
  // waveform on the right half
  waveform(ctx, px + pw * 0.52, py + ph / 2 - 16, pw * 0.36, 32)
  // stop hint under the pill
  text(ctx, 'tap ● send    ●● cancel', W / 2, py + ph + 22, 16, DIM, 600, 'center')
}

// ── MOCKUP 4: icon board (candidate status + nav marks) ─────────────────────
function drawIconBoard(ctx: CanvasRenderingContext2D) {
  text(ctx, 'STATUS', 24, 26, 15, DIM, 700)
  const sy = 74
  const cells: [string, () => void][] = [
    ['live', () => statusMark(ctx, 0, 0, 'live', 12)],
    ['needs', () => statusMark(ctx, 0, 0, 'needs', 12)],
    ['idle', () => statusMark(ctx, 0, 0, 'idle', 12)],
    ['bell', () => bell(ctx, 0, 0, 26)],
  ]
  cells.forEach(([label, fn], i) => {
    const cx = 60 + i * 130
    ctx.save(); ctx.translate(cx, sy); fn(); ctx.restore()
    text(ctx, label, cx, sy + 34, 15, DIM, 600, 'center')
  })
  text(ctx, 'NAV', 24, 150, 15, DIM, 700)
  const ny = 198
  const navs: [string, () => void][] = [
    ['back', () => chevron(ctx, 0, 0, 12, 'left')],
    ['open', () => chevron(ctx, 0, 0, 12, 'right')],
    ['up', () => chevron(ctx, 0, 0, 12, 'up')],
    ['down', () => chevron(ctx, 0, 0, 12, 'down')],
  ]
  navs.forEach(([label, fn], i) => {
    const cx = 60 + i * 130
    ctx.save(); ctx.translate(cx, ny); fn(); ctx.restore()
    text(ctx, label, cx, ny + 34, 15, DIM, 600, 'center')
  })
}

const MOCKS: Record<string, Draw> = {
  'lab-projects': drawProjectsHome,
  'lab-sessions': drawSessions,
  'lab-listening': drawListening,
  'lab-icons': drawIconBoard,
}

// ── push a full-screen canvas to the lens as a 3×2 grid of image tiles ──────
async function pushFullScreen(draw: Draw) {
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  draw(ctx)

  const COLS = 3, ROWS = 2, TW = W / COLS, TH = H / ROWS // 192 × 144 (≤ image limit)
  const tiles: { id: number; name: string; x: number; y: number; w: number; h: number; bytes: Uint8Array }[] = []
  let id = 2
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const name = `lab_${r}_${c}`
    const enc = encodeTilesBatch(canvas, [{ crop: { sx: c * TW, sy: r * TH, sw: TW, sh: TH }, name }], TW, TH)[0]!
    tiles.push({ id: id++, name, x: c * TW, y: r * TH, w: TW, h: TH, bytes: enc.bytes })
  }

  const raw = await GlassesSdk.getRawBridge()
  const overlay = new TextContainerProperty({
    containerID: 1, containerName: 'overlay', xPosition: 0, yPosition: 0, width: W, height: H,
    borderWidth: 0, borderColor: 0, paddingLength: 0, content: '', isEventCapture: 1,
  })
  const imageObject = tiles.map((t) => new ImageContainerProperty({
    containerID: t.id, containerName: t.name, xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
  }))
  const fields = { containerTotalNum: 1 + tiles.length, textObject: [overlay], imageObject }
  const shared = (globalThis as Record<string, any>).__glassesToolkitSharedState
  if (!shared || shared.currentPageId == null) await raw.createStartUpPageContainer(new CreateStartUpPageContainer(fields))
  else await raw.rebuildPageContainer(new RebuildPageContainer(fields))
  if (shared) shared.currentPageId = 'lab'
  for (const t of tiles) await raw.updateImageRawData(new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: t.bytes }))
}

/** Renders nothing to the DOM; on mount it pushes the named mockup to the lens. */
export function Lab({ name }: { name: string }) {
  useEffect(() => {
    const draw = MOCKS[name]
    if (draw) pushFullScreen(draw).catch((e) => console.error('[lab] render failed', e))
  }, [name])
  return null
}

// Reusable primitives + tile push for the Phase 3 live renderer (see phase3.tsx).
export type { Draw }
export { roundRect, badge, bell, statusMark, chevron, waveform, text, pushFullScreen, W, H, FG, FG2, DIM, FAINT, STROKE }
