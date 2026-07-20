// Image-container hero for the interrupt screen — a prototype of the "spend a few
// bitmap sprites where pixels earn their keep" path. Renders a notification
// bell + a big system-font headline to a canvas, then encodes 3 × 200×100 tiles
// (a 576×100 band) the way even-toolkit's splash does. The display is 16-level
// greyscale, so anti-aliased type and icons read cleanly — none of this is
// possible in the firmware text container.
import { encodeTilesBatch } from 'even-toolkit/png-utils'
import { IMAGE_TILES, G2_IMAGE_MAX_W } from 'even-toolkit/layout'

export interface HeroTile {
  id: number; name: string; bytes: Uint8Array
  x: number; y: number; w: number; h: number
}

// A 3-tile band, each 200×144 (within the 288×144 image limit) → a 576×144 region
// that holds the ENTIRE screen: icon, headline, subline, and gesture footer. No
// firmware text at all, so nothing reads like a terminal.
const TW = G2_IMAGE_MAX_W // 200
const TH = 144            // taller than the 100 default (max image height)
const COLS = 3
const BAND_Y = 72         // (288 − 144) / 2 → vertically centred
// Kept as a settled promise so the HUD renderer's existing readiness lifecycle
// remains stable without loading React's server renderer and a complete icon set.
export const iconReady: Promise<void> = Promise.resolve()

function clip(text: string, n: number): string {
  return text.length > n ? text.slice(0, n).trimEnd() + '…' : text
}

// A clean notification bell, centred on (cx, topY). Stroked, round joins — the
// grey ramp anti-aliases it on the lens.
function drawBell(ctx: CanvasRenderingContext2D, cx: number, topY: number, s: number) {
  ctx.save()
  ctx.strokeStyle = '#efefef'
  ctx.fillStyle = '#efefef'
  ctx.lineWidth = 2.5
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const top = topY + 4
  const bottom = topY + s
  const halfTop = s * 0.10
  const halfBot = s * 0.42

  // top nub
  ctx.beginPath(); ctx.arc(cx, top - 3, 2.4, 0, Math.PI * 2); ctx.fill()
  // bell body — narrow shoulders flaring to a wide skirt
  ctx.beginPath()
  ctx.moveTo(cx - halfBot, bottom)
  ctx.quadraticCurveTo(cx - halfBot, bottom - s * 0.28, cx - halfTop * 1.6, top + s * 0.16)
  ctx.quadraticCurveTo(cx - halfTop, top, cx, top)
  ctx.quadraticCurveTo(cx + halfTop, top, cx + halfTop * 1.6, top + s * 0.16)
  ctx.quadraticCurveTo(cx + halfBot, bottom - s * 0.28, cx + halfBot, bottom)
  ctx.stroke()
  // rim
  ctx.beginPath()
  ctx.moveTo(cx - halfBot - 2, bottom)
  ctx.lineTo(cx + halfBot + 2, bottom)
  ctx.stroke()
  // clapper
  ctx.beginPath(); ctx.arc(cx, bottom + 5, 3, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

// Draw `n` filled gesture dots starting at left edge `x`, vertically centred on
// `cy`. Returns the x just past the last dot. One dot = tap, two = double-tap.
function drawDots(ctx: CanvasRenderingContext2D, x: number, cy: number, n: number, r: number): number {
  let cur = x
  for (let i = 0; i < n; i++) {
    ctx.beginPath(); ctx.arc(cur + r, cy, r, 0, Math.PI * 2); ctx.fill()
    cur += r * 2 + (i < n - 1 ? 3 : 0)
  }
  return cur
}

// The gesture footer, drawn INTO the bitmap: "● Review    ●● Dismiss". No words
// like "tap" — the dot count is the gesture (1 = tap, 2 = double-tap).
function drawGestureFooter(ctx: CanvasRenderingContext2D, cx: number, baseY: number) {
  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.font = "600 15px system-ui, -apple-system, 'Segoe UI', sans-serif"
  ctx.fillStyle = '#d6d6d6'
  const r = 3, dotGap = 7, groupGap = 26
  const w1 = 2 * r                 // one dot
  const w2 = 2 * r + 3 + 2 * r     // two dots
  const wReview = ctx.measureText('Review').width
  const wDismiss = ctx.measureText('Dismiss').width
  const total = w1 + dotGap + wReview + groupGap + w2 + dotGap + wDismiss
  const cy = baseY - 5
  let x = cx - total / 2
  x = drawDots(ctx, x, cy, 1, r) + dotGap
  ctx.fillText('Review', x, baseY); x += wReview + groupGap
  x = drawDots(ctx, x, cy, 2, r) + dotGap
  ctx.fillText('Dismiss', x, baseY)
  ctx.restore()
}

/** Render the interrupt hero and return positioned, encoded image tiles. */
export function renderInterruptHero(name: string, reason: string): HeroTile[] {
  const canvas = document.createElement('canvas')
  canvas.width = COLS * TW  // 600
  canvas.height = TH        // 144
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Display is 0..576 across the 600px canvas → its centre is x=288.
  const cx = 288
  ctx.textAlign = 'center'

  drawBell(ctx, cx, 12, 34)

  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'alphabetic'
  ctx.font = "700 28px system-ui, -apple-system, 'Segoe UI', sans-serif"
  ctx.fillText('NEEDS YOU', cx, 96)

  ctx.fillStyle = '#b8b8b8'
  ctx.font = "500 14px system-ui, -apple-system, 'Segoe UI', sans-serif"
  ctx.fillText(`${clip(name, 30)}  ·  ${reason}`, cx, 116)

  drawGestureFooter(ctx, cx, 138)

  const tiles: HeroTile[] = []
  for (let i = 0; i < COLS; i++) {
    const slot = IMAGE_TILES[i]!
    const enc = encodeTilesBatch(
      canvas,
      [{ crop: { sx: i * TW, sy: 0, sw: TW, sh: TH }, name: slot.name }],
      TW, TH,
    )[0]!
    tiles.push({ id: slot.id, name: slot.name, bytes: enc.bytes, x: i * TW, y: BAND_Y, w: TW, h: TH })
  }
  return tiles
}
