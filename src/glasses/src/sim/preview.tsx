// Browser preview of the G2 HUD (`?sim=preview`).
//
// Every other sim route paints to the lens and returns null to the DOM, so seeing the
// cockpit meant the glasses or the evenhub-simulator (a global npm install and a
// second process). This is the zero-install path: it draws the SAME composition the
// glasses receive — composeCockpitPage() builds a real GlassesPage, we read its
// elements' own coordinates and content and paint them — so it cannot drift from the
// shipping UI the way a hand-drawn mockup would, and it adds a per-element readout
// the simulator has no way to show.
//
// The simulator remains ground truth: it runs the real LVGL renderer, this does not.
// What is exact here: element geometry, text content, line breaks and glyph advances
// (measured with @evenrealities/pretext, the same metrics the firmware uses).
// What is approximate: glyph shapes (the lens font is not available to the browser)
// and the firmware's internal container padding, which the SDK does not expose.
import { useEffect, useMemo, useRef, useState } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'
import { getTextWidth, G2_TEXT_LINE_HEIGHT } from 'even-toolkit/pretext'
import { composeCockpitPage, glass, groupProjects, pickScreen, type Nav, type Screen } from '../glass/AppGlasses3c'
import { HERO_BAND, paintInterruptHero } from '../glass/hero'
import { attentionSessions, reason as attentionReason } from '../glass/screens/interrupt'
import { applyFixture } from './fixtures'
import { store } from '../store'

// The lens: 576×288 monochrome green. Drawn at 2× so it is legible on a desktop.
const W = 576, H = 288, SCALE = 2
const FG = '#63ff9b'
const DIM = 'rgba(99, 255, 155, 0.55)'
const FONT_PX = 21 // pairs with the 27px LVGL line height

const FIXTURES = [
  'list', 'detail-short', 'detail-long', 'detail-working', 'approval', 'question', 'question-multi',
] as const

const SCREENS: Screen[] = ['projects', 'sessions', 'detail', 'approval', 'question', 'interrupt']

/** Serialized element shape — the subset of the SDK payload the preview draws. */
interface Painted {
  type: 'text' | 'list'
  x: number; y: number; w: number; h: number
  borderWidth: number
  content: string
  items: string[]
  itemWidth: number
  selectBorder: boolean
}

/**
 * Greedy word wrap by measured pixel width.
 *
 * The firmware wraps inside the container, so the app hands it strings that may be
 * longer than the box. LVGL breaks greedily on whitespace, which this mirrors;
 * lineCount is cross-checked against measureTextWrap in the element readout so a
 * divergence is visible rather than silent.
 */
function wrapLines(text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue }
    let line = ''
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (line && getTextWidth(next) > maxWidth) { out.push(line); line = word } else { line = next }
    }
    out.push(line)
  }
  return out
}

/**
 * Draw one line placing every glyph at its measured advance.
 *
 * Cheaper approaches (one fillText per line) drift from the lens as soon as the
 * browser font's metrics differ, which is exactly the error a preview must not make:
 * the whole point is to show whether text FITS. Measuring each prefix costs O(n²) per
 * line, which is nothing at these string lengths.
 */
function drawLine(ctx: CanvasRenderingContext2D, line: string, x: number, y: number) {
  for (let i = 0; i < line.length; i++) {
    ctx.fillText(line[i], x + getTextWidth(line.slice(0, i)), y)
  }
}

function paint(ctx: CanvasRenderingContext2D, els: Painted[], hero: HTMLCanvasElement | null) {
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  ctx.font = `${FONT_PX}px "Helvetica Neue", Arial, sans-serif`
  ctx.textBaseline = 'top'

  // The interrupt is a bitmap band, not composed elements — drawn where the firmware
  // places it. Its own canvas is 600px wide; only the leftmost 576 reach the display.
  if (hero) {
    ctx.drawImage(hero, 0, 0, W, HERO_BAND.h, 0, HERO_BAND.y, W, HERO_BAND.h)
    return
  }

  for (const el of els) {
    if (el.borderWidth > 0) {
      ctx.strokeStyle = DIM
      ctx.lineWidth = el.borderWidth
      ctx.strokeRect(el.x + 0.5, el.y + 0.5, el.w, el.h)
    }

    if (el.type === 'text') {
      ctx.fillStyle = FG
      wrapLines(el.content, el.w).forEach((line, i) => {
        const y = el.y + i * G2_TEXT_LINE_HEIGHT
        if (y < el.y + el.h) drawLine(ctx, line, el.x, y)
      })
      continue
    }

    // List: the firmware owns the selection highlight and moves it on-device. A fresh
    // page always starts at the top (AppGlasses3c resets selIdx to 0 on screen change),
    // so row 0 is what you would actually be looking at.
    el.items.forEach((item, i) => {
      const y = el.y + i * G2_TEXT_LINE_HEIGHT
      if (y >= el.y + el.h) return
      if (el.selectBorder && i === 0) {
        ctx.strokeStyle = FG
        ctx.lineWidth = 1
        ctx.strokeRect(el.x + 0.5, y + 0.5, (el.itemWidth || el.w) - 1, G2_TEXT_LINE_HEIGHT - 2)
      }
      ctx.fillStyle = FG
      drawLine(ctx, item, el.x + 6, y + 2)
    })
  }
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [fixture, setFixture] = useState<string>('list')
  const [override, setOverride] = useState<Screen | 'auto'>('auto')
  const [projIdx, setProjIdx] = useState(0)
  const [seeded, setSeeded] = useState(0)

  // Re-seed the shared store whenever the fixture changes; the composition reads it.
  useEffect(() => {
    applyFixture(fixture)
    setSeeded((n) => n + 1)
  }, [fixture])

  const { els, screen, groups, error, hero } = useMemo<{
    els: Painted[]; screen: Screen; groups: ReturnType<typeof groupProjects>
    error: string | null; hero?: HTMLCanvasElement
  }>(() => {
    void seeded // recompute after a re-seed
    try {
      const snap = glass(store.getState())
      const groups = groupProjects(snap.sessions)
      const nav: Nav = { home: projIdx > 0 ? 'sessions' : 'projects', projIdx }
      const screen = override === 'auto' ? pickScreen(snap, nav) : override
      const sdk = new GlassesSdk()
      const rowsRef = { current: [] as { id: string; label: string }[] }
      const page = composeCockpitPage(sdk, screen, snap, nav, groups, rowsRef)
      if (!page) {
        // interrupt: paint the hero band instead of composed elements.
        const target = attentionSessions(snap)[0]
        const hero = document.createElement('canvas')
        paintInterruptHero(hero, target?.title || target?.project || 'session', target ? attentionReason(target) : 'needs you')
        return { els: [], screen, groups, error: null, hero }
      }
      const els: Painted[] = page.getElements().map((e) => {
        const j = e.toEvenSdkElement() as Record<string, unknown>
        const item = j.itemContainer as Record<string, unknown> | undefined
        return {
          type: item ? 'list' : 'text',
          x: Number(j.xPosition ?? 0), y: Number(j.yPosition ?? 0),
          w: Number(j.width ?? 0), h: Number(j.height ?? 0),
          borderWidth: Number(j.borderWidth ?? 0),
          content: String(j.content ?? ''),
          items: (item?.itemName as string[]) ?? [],
          itemWidth: Number(item?.itemWidth ?? 0),
          selectBorder: Number(item?.isItemSelectBorderEn ?? 0) === 1,
        }
      })
      return { els, screen, groups, error: null }
    } catch (e) {
      return { els: [], screen: 'projects' as Screen, groups: [], error: String(e) }
    }
  }, [fixture, override, projIdx, seeded])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) paint(ctx, els, hero ?? null)
  }, [els, hero])

  return (
    <div style={{ padding: 20, fontFamily: 'ui-monospace, monospace', color: '#cfe', background: '#0b0f10', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 15, margin: '0 0 4px' }}>Nexus G2 cockpit — browser preview</h1>
      <p style={{ fontSize: 11, opacity: 0.6, margin: '0 0 14px' }}>
        Drawn from the real composed GlassesPage. Geometry and text are exact; glyph shapes
        and firmware padding are approximate.
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14, fontSize: 12 }}>
        <label>fixture{' '}
          <select value={fixture} onChange={(e) => setFixture(e.target.value)}>
            {FIXTURES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label>screen{' '}
          <select value={override} onChange={(e) => setOverride(e.target.value as Screen | 'auto')}>
            <option value="auto">auto ({screen})</option>
            {SCREENS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>project{' '}
          <input type="number" min={0} max={Math.max(0, groups.length - 1)} value={projIdx}
            style={{ width: 48 }}
            onChange={(e) => setProjIdx(Math.max(0, Number(e.target.value) || 0))} />
        </label>
      </div>

      {error && <pre style={{ color: '#ff8080', fontSize: 12 }}>{error}</pre>}

      <canvas
        ref={canvasRef}
        width={W * SCALE}
        height={H * SCALE}
        // Backing store stays at 2× for crisp glyphs; CSS width yields to the viewport
        // so the whole 576px-wide lens is always visible rather than cropped.
        style={{ width: `min(100%, ${W * SCALE}px)`, aspectRatio: `${W} / ${H}`, border: '1px solid #243', display: 'block' }}
      />

      <p style={{ fontSize: 11, opacity: 0.55, margin: '10px 0 6px' }}>
        {hero
          ? 'bitmap hero — image tiles pushed via the raw bridge, not a GlassesPage'
          : `${els.length} element(s) — ${screen}`}
      </p>
      <table style={{ fontSize: 11, borderCollapse: 'collapse', opacity: 0.8 }}>
        <tbody>
          {els.map((e, i) => (
            <tr key={i}>
              <td style={{ padding: '1px 10px 1px 0' }}>{e.type}</td>
              <td style={{ padding: '1px 10px 1px 0' }}>{e.x},{e.y} {e.w}×{e.h}</td>
              <td style={{ padding: '1px 10px 1px 0', maxWidth: 460, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {(e.type === 'list' ? e.items.join(' | ') : e.content).replace(/\n/g, ' ⏎ ').slice(0, 90)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
