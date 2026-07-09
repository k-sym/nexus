// Phase 3 FIRMWARE-TEXT prototype — the approved projects→sessions design rebuilt
// on the fast firmware text/list path (native lists render on-device, the
// select-border highlight moves on-device, scrolling ships ZERO pixels) instead
// of bitmaps, which are throttled by the Even app's BLE link. Reuses the Phase 2
// renderer's element approach. ?sim=fw.
import { useEffect, useRef } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'
import { getTextWidth } from 'even-toolkit/pretext'
import { paginateText } from 'even-toolkit/paginate-text'
import { DATA } from './phase3'

const REPLY_COLS = 42, REPLY_ROWS = 7 // reply pagination for the detail body

const LINE = 0xffffff as never // the one deliberate border (detail header bar)

const GLYPH = { needs: '◆', live: '●', idle: '○' } as const
// ✳ is TOFU on the firmware font; ★ renders and reads as "special".
const badgeChar = (g: string) => (g === '✳' ? '★' : g)

type Screen = 'projects' | 'sessions' | 'detail'

export function Phase3FW() {
  // ?screen= lets the sim jump straight to a screen for screenshots.
  const initial = (new URLSearchParams(window.location.search).get('screen') as Screen) || 'projects'
  const nav = useRef<{ screen: Screen; proj: number; sel: number; page: number }>({ screen: initial, proj: 0, sel: 0, page: 0 })

  useEffect(() => {
    const sdk = new GlassesSdk()
    GlassesSdk.getRawBridge()
      .then((raw) => { (window as unknown as Record<string, unknown>).__evenBridge = { rawBridge: raw, onEvent: (h: (e: unknown) => void) => sdk.addEventListener(h) } })
      .catch(() => {})

    const render = async () => {
      const n = nav.current
      const page = sdk.createPage(`fw-${n.screen}`)

      if (n.screen === 'projects') {
        const rows = DATA.map((p) => {
          const needs = p.sessions.some((s) => s.icon === 'needs')
          const meta = needs ? 'needs you' : p.asst ? `${p.sessions.length} chats` : `${p.sessions.length}`
          return `${badgeChar(p.g)}   ${p.name}   ·   ${meta}`
        })
        const list = page.addListElement(rows)
        list.setItemWidth(536)
        list.setIsItemSelectBorderEn(true)
        list.markAsEventCaptureElement()
        list.setPosition((p) => { p.setX(18).setY(12) })
        list.setSize((z) => { z.setWidth(540).setHeight(264) })
      } else if (n.screen === 'sessions') {
        // Minimal: no frames at all. The rail is just the project letters with ›
        // marking the current one; the ONLY border on screen is the native
        // select-highlight on the session list.
        const railX = 10, railW = 48, railY = 12
        const rail = page.addTextElement(DATA.map((p, i) => `${i === n.proj ? '›' : ' '} ${badgeChar(p.g)}`).join('\n\n'))
        rail.setPosition((p) => { p.setX(railX).setY(railY) })
        rail.setSize((z) => { z.setWidth(railW).setHeight(264) })

        const sessions = DATA[n.proj].sessions
        const rows = sessions.length
          ? sessions.map((s) => `${GLYPH[s.icon]}  ${s.title}   ·   ${s.meta}`)
          : ['(no active sessions)']
        const listX = railX + railW + 12
        const list = page.addListElement(rows)
        list.setItemWidth(576 - listX - 22)
        list.setIsItemSelectBorderEn(true)
        list.markAsEventCaptureElement()
        list.setPosition((p) => { p.setX(listX).setY(10) })
        list.setSize((z) => { z.setWidth(576 - listX - 14).setHeight(268) })
      } else {
        const s = DATA[n.proj].sessions[n.sel]
        const pages = paginateText(s?.reply ?? '', REPLY_COLS, REPLY_ROWS).map((ls) => ls.join('\n'))
        const total = Math.max(1, pages.length)
        const pg = Math.min(Math.max(0, n.page), total - 1)
        const hint = '● steer   ●● back'
        const hx = 8, hy = 8, hw = 560, hh = 36
        // The one deliberate border: a header bar. Session name (+ page k/N) left…
        const header = page.addTextElement(`‹ ${s?.title ?? 'session'}${total > 1 ? `   ${pg + 1}/${total}` : ''}`)
        header.setBorder((b) => b.setWidth(2).setColor(LINE).setRadius(10))
        header.setPosition((p) => { p.setX(hx).setY(hy) })
        header.setSize((z) => { z.setWidth(hw).setHeight(hh) })
        // …controls on the right. Firmware text is left-aligned, so measure the
        // string (pretext / LVGL metrics) and place its own element flush-right.
        const hintW = Math.ceil(getTextWidth(hint))
        const right = page.addTextElement(hint)
        right.setPosition((p) => { p.setX(hx + hw - hintW - 22).setY(hy + 6) })
        right.setSize((z) => { z.setWidth(hintW + 18).setHeight(hh - 10) })
        // reply body — frameless, event-capture (so scroll pages IT, not the header)
        const bodyY = hy + hh + 10
        const body = page.addTextElement(pages[pg] ?? '')
        body.markAsEventCaptureElement()
        body.setPosition((p) => { p.setX(hx + 4).setY(bodyY) })
        body.setSize((z) => { z.setWidth(hw - 8).setHeight(288 - bodyY - 8) })
      }
      await page.render()
    }

    // Native list moves the highlight on-device as you scroll — we DON'T re-render
    // (that's the speed win); we only track the index for tap and re-render on
    // drill in/out.
    let selIdx = 0
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    const rowCount = () => nav.current.screen === 'projects'
      ? DATA.length
      : nav.current.screen === 'sessions' ? Math.max(1, DATA[nav.current.proj].sessions.length) : 1
    const enter = (idx: number) => {
      const n = nav.current
      if (n.screen === 'projects') { if (DATA[idx]?.sessions.length) { n.screen = 'sessions'; n.proj = idx; selIdx = 0; void render() } }
      else if (n.screen === 'sessions') { if (DATA[n.proj].sessions.length) { n.screen = 'detail'; n.sel = idx; n.page = 0; void render() } }
    }
    const back = () => {
      const n = nav.current
      if (n.screen === 'detail') { n.screen = 'sessions'; selIdx = 0; void render() }
      else if (n.screen === 'sessions') { n.screen = 'projects'; selIdx = 0; void render() }
    }
    // Detail screen: firmware text can't scroll, so scroll pages the reply.
    const pageDetail = (delta: number) => {
      const n = nav.current
      const total = Math.max(1, paginateText(DATA[n.proj].sessions[n.sel]?.reply ?? '', REPLY_COLS, REPLY_ROWS).length)
      const next = Math.max(0, Math.min(total - 1, n.page + delta))
      if (next !== n.page) { n.page = next; void render() }
    }
    const onEvent = (event: unknown) => {
      const e = event as Record<string, any>
      if (e?.audioEvent) return
      const le = e?.listEvent
      const et = le?.eventType ?? e?.textEvent?.eventType ?? e?.sysEvent?.eventType
      if (et === 3) { if (tapTimer) { clearTimeout(tapTimer); tapTimer = null } return back() }
      if (et === 1) { if (nav.current.screen === 'detail') { pageDetail(-1); return } selIdx = Math.max(0, selIdx - 1); return }
      if (et === 2) { if (nav.current.screen === 'detail') { pageDetail(1); return } selIdx = Math.min(rowCount() - 1, selIdx + 1); return }
      const idx = le && typeof le.currentSelectItemIndex === 'number' ? le.currentSelectItemIndex : selIdx
      if (tapTimer) clearTimeout(tapTimer)
      tapTimer = setTimeout(() => { tapTimer = null; enter(idx) }, 260)
    }
    sdk.addEventListener(onEvent)
    void render()
    return () => { if (tapTimer) clearTimeout(tapTimer); sdk.removeEventListener(onEvent) }
  }, [])

  return null
}
