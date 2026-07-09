// Glyph test sheet — renders candidate symbols through the firmware TEXT path
// (not bitmaps, which would draw anything) so we can see exactly which the G2
// LVGL font supports vs. renders as TOFU/blank. ?sim=glyphs. Rows are labelled
// so a blank means that glyph isn't in the font.
import { useEffect } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'

const BORDER = 0xffffff as never

const SHEET = [
  'circ  ● ◐ ◑ ○ ◉ ⦿ ⊙ ◍ ◎',
  'sqr   ■ □ ▪ ▫ ◆ ◇ ◈ ▣ ▨',
  'tri   ▲ ▼ ► ◄ ▶ ◀ △ ▷ ▸',
  'star  ★ ☆ ✦ ✧ ✱ ✳ ✴ ＊ *',
  'arrow ‹ › « » ← → ↑ ↓ ⌃ ⌄',
  'dots  · • ∙ ‣ ◦ ⁃ ⋮ ⋯ …',
  'bars  │ ┃ ▌ █ ░ ▒ ▓ ═ ─',
  'live  ⟳ ↻ ↺ ⇄ ⧗ ⧖ ⚑ ⚐ ⏻',
]

export function Glyphs() {
  useEffect(() => {
    const sdk = new GlassesSdk()
    ;(async () => {
      const page = sdk.createPage('glyphs')
      const card = page.addTextElement(SHEET.join('\n'))
      card.setBorder((b) => b.setWidth(2).setColor(BORDER).setRadius(12))
      card.setPosition((p) => { p.setX(12).setY(8) })
      card.setSize((z) => { z.setWidth(552).setHeight(272) })
      await page.render()
    })().catch(() => {})
  }, [])
  return null
}
