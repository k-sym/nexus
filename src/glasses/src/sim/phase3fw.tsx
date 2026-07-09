// Phase 3 FIRMWARE-TEXT prototype — the approved projects→sessions design rebuilt
// on the fast firmware text/list path (native lists render on-device, the
// select-border highlight moves on-device, scrolling ships ZERO pixels) instead
// of bitmaps, which are throttled by the Even app's BLE link. Reuses the Phase 2
// renderer's element approach. ?sim=fw.
import { useEffect, useRef } from 'react'
import { GlassesSdk } from 'even-toolkit/sdk-wrapper'
import { DATA } from './phase3'

const GLYPH = { needs: '◆', live: '●', idle: '○' } as const
// ✳ is TOFU on the firmware font; ★ renders and reads as "special".
const badgeChar = (g: string) => (g === '✳' ? '★' : g)

type Screen = 'projects' | 'sessions' | 'detail'

export function Phase3FW() {
  // ?screen= lets the sim jump straight to a screen for screenshots.
  const initial = (new URLSearchParams(window.location.search).get('screen') as Screen) || 'projects'
  const nav = useRef<{ screen: Screen; proj: number; sel: number }>({ screen: initial, proj: 0, sel: 0 })

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
        const card = page.addTextElement(`‹ ${s?.title ?? 'session'}\n\n${s?.reply ?? ''}\n\n● steer      ●● back`)
        card.markAsEventCaptureElement()
        card.setPosition((p) => { p.setX(16).setY(10) })
        card.setSize((z) => { z.setWidth(544).setHeight(268) })
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
      else if (n.screen === 'sessions') { if (DATA[n.proj].sessions.length) { n.screen = 'detail'; n.sel = idx; void render() } }
    }
    const back = () => {
      const n = nav.current
      if (n.screen === 'detail') { n.screen = 'sessions'; selIdx = 0; void render() }
      else if (n.screen === 'sessions') { n.screen = 'projects'; selIdx = 0; void render() }
    }
    const onEvent = (event: unknown) => {
      const e = event as Record<string, any>
      if (e?.audioEvent) return
      const le = e?.listEvent
      const et = le?.eventType ?? e?.textEvent?.eventType ?? e?.sysEvent?.eventType
      if (et === 3) { if (tapTimer) { clearTimeout(tapTimer); tapTimer = null } return back() }
      if (et === 1) { selIdx = Math.max(0, selIdx - 1); return }
      if (et === 2) { selIdx = Math.min(rowCount() - 1, selIdx + 1); return }
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
