// Glyph test sheets — rendered through the firmware TEXT path (not bitmaps, which
// would draw anything) so we see exactly what the G2 LVGL font supports vs TOFU.
//   ?sim=glyphs            geometric Unicode symbols
//   ?sim=glyphs&set=syms   LVGL / FontAwesome symbol subset (private-use codepoints)
// Blank cell = that glyph isn't in the font.
import { useEffect } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'

const BORDER = 0xffffff as never

const GEOMETRIC = [
  'circ  ● ◐ ◑ ○ ◉ ⦿ ⊙ ◍ ◎',
  'sqr   ■ □ ▪ ▫ ◆ ◇ ◈ ▣ ▨',
  'tri   ▲ ▼ ► ◄ ▶ ◀ △ ▷ ▸',
  'star  ★ ☆ ✦ ✧ ✱ ✳ ✴ ＊ *',
  'arrow ‹ › « » ← → ↑ ↓ ⌃ ⌄',
  'dots  · • ∙ ‣ ◦ ⁃ ⋮ ⋯ …',
  'bars  │ ┃ ▌ █ ░ ▒ ▓ ═ ─',
  'live  ⟳ ↻ ↺ ⇄ ⧗ ⧖ ⚑ ⚐ ⏻',
]

// LVGL / FontAwesome symbol codepoints (private use area). If the firmware font
// bundles this subset, these render as real icons.
const SYMS: Array<[string, number]> = [
  ['flag', 0xf024], ['bell', 0xf0f3], ['warn', 0xf071], ['excl', 0xf06a],
  ['circle', 0xf111], ['dotcirc', 0xf192], ['check', 0xf058], ['star', 0xf005],
  ['play', 0xf04b], ['pause', 0xf04c], ['power', 0xf011], ['home', 0xf015],
  ['refresh', 0xf021], ['wifi', 0xf1eb], ['batt', 0xf240], ['bluetooth', 0xf293],
  ['envelope', 0xf0e0], ['list', 0xf00b], ['bars', 0xf0c9], ['eye', 0xf06e],
  ['bullhorn', 0xf0a1], ['ok', 0xf00c], ['close', 0xf00d], ['edit', 0xf304],
]

function symSheet(): string {
  const lines: string[] = []
  for (let i = 0; i < SYMS.length; i += 3) {
    lines.push(SYMS.slice(i, i + 3).map(([l, c]) => `${l} ${String.fromCodePoint(c)}`).join('    '))
  }
  return lines.join('\n')
}

// Circle-with-dot candidates, tested in a LIST element (the same context as the
// session status glyph — glyphs can render there differently than in text).
const CIRCLES = [
  '● filled', '◐ half', '◑ half-right', '○ hollow',
  '◉ fisheye', '⊙ dot-in-circle', '◎ bullseye', '⦿ circled-bullet',
  '◍ dashed', '⊚ circled-ring', '⊛ circled-star', '๏ thai-o',
]

// Tap-control indicator candidates (1 tap / 2 taps), lighter than ● / ●●.
const TAPS = [
  '(fill)  ● steer     ●● back',
  '(bull)  • steer     •• back',
  '(dot)   · steer     ·· back',
  '(chev)  › steer     » back',
  '(mix)   • steer     » back',
  '(word)  tap steer   2x back',
]

export function Glyphs() {
  useEffect(() => {
    const set = new URLSearchParams(window.location.search).get('set')
    const sdk = new GlassesSdk()
    ;(async () => {
      const page = sdk.createPage('glyphs')
      if (set === 'taps') {
        const card = page.addTextElement(TAPS.join('\n\n'))
        card.setPosition((p) => { p.setX(16).setY(12) })
        card.setSize((z) => { z.setWidth(544).setHeight(264) })
      } else if (set === 'circles') {
        const list = page.addListElement(CIRCLES)
        list.setItemWidth(540)
        list.setIsItemSelectBorderEn(true)
        list.markAsEventCaptureElement()
        list.setPosition((p) => { p.setX(16).setY(10) })
        list.setSize((z) => { z.setWidth(544).setHeight(268) })
      } else {
        const content = set === 'syms' ? symSheet() : GEOMETRIC.join('\n')
        const card = page.addTextElement(content)
        card.setBorder((b) => b.setWidth(2).setColor(BORDER).setRadius(12))
        card.setPosition((p) => { p.setX(12).setY(8) })
        card.setSize((z) => { z.setWidth(552).setHeight(272) })
      }
      await page.render()
    })().catch(() => {})
  }, [])
  return null
}
