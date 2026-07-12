import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { store } from './store'
import './app.css'

// Auto-connect from the URL: ?hub=<url>&token=<t>. Handy for the Even app /
// evenhub-simulator, which loads a target URL but can't fill the Connect form.
// Only seeds when nothing is stored yet, so it never overrides a saved hub.
// ?stt=<provider>&sttKey=<key> likewise configures the voice-answer backend (Phase 4b)
// on-device via the QR link; persisted to localStorage, read by sttConfig().
async function seedFromHub() {
  const params = new URLSearchParams(window.location.search)
  const hub = params.get('hub')
  const origin = window.location.origin
  const stored = store.getState().baseUrl
  // Decide the hub URL:
  //  • explicit ?hub= always wins (QR / simulator).
  //  • nothing stored yet → default to the serving origin (Nexus hosts the cockpit
  //    same-origin, so the gateway API is right here — no query param needed).
  //  • a hub IS stored but differs from this origin → it may be STALE (e.g. an old
  //    dev-server / LAN URL from earlier testing that now fails, or is blocked as
  //    mixed-content from this HTTPS page). Heal it by adopting the origin, but ONLY
  //    when the origin is itself a healthy gateway — i.e. Nexus is hosting us. In the
  //    `.ehpk` model the origin is a local package (no gateway), so the probe fails
  //    and we keep the stored remote hub the user entered on the Connect screen.
  if (hub) {
    // Explicit ?hub= (QR / simulator) always wins.
    store.setCredentials(hub, params.get('token') ?? '')
  } else {
    // Is THIS origin itself a Nexus gateway? True when Nexus hosts the cockpit
    // same-origin (dev-load / hosted). False for an installed .ehpk, whose origin is
    // a local package (appassets…) with no /api — there the gateway is REMOTE and the
    // Connect screen must prompt for its URL (we must NOT point the app at itself).
    let originIsGateway = false
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3000)
      const r = await fetch(`${origin}/api/health`, { cache: 'no-store', signal: ctl.signal })
      clearTimeout(t)
      // Verify it's the gateway's health JSON ({ok:true}), not an SPA-fallback HTML
      // page a local .ehpk server might return 200 for on an unknown path.
      const body = r.ok ? await r.json().catch(() => null) : null
      originIsGateway = body?.ok === true
    } catch { /* not a gateway */ }

    if (originIsGateway) {
      // Hosted same-origin: adopt the origin as the hub, healing any stale stored value.
      if (stored !== origin) store.setCredentials(origin, params.get('token') ?? '')
    } else if (stored === origin) {
      // Installed .ehpk whose hub a prior build wrongly defaulted to its own local
      // origin — clear it so the Connect screen prompts for the real (remote) gateway.
      store.setCredentials('', params.get('token') ?? '')
    }
    // else (.ehpk): stored empty → Connect prompts; or a real remote hub → keep it.
  }
  // ?stt=/?sttKey= configure the voice backend on-device via the QR link (dev-load).
  const stt = params.get('stt'); if (stt) localStorage.setItem('cockpit.sttProvider', stt)
  const sttKey = params.get('sttKey'); if (sttKey) localStorage.setItem('cockpit.sttKey', sttKey)
  // The STT key from Nexus config (GET /api/cockpit-config) is seeded in HubFeed once
  // the hub URL is known — NOT here — because the installed .ehpk has an empty baseUrl
  // at boot (the Connect screen sets it), so a boot-time fetch would miss it.
}

// `?sim=<scenario>` seeds a canned HUD screen for the evenhub-simulator (no live
// gateway). Lazy-imported so the fixtures stay out of the production bundle;
// <App> then skips HubFeed so nothing overwrites the seed.
async function boot() {
  const simName = new URLSearchParams(window.location.search).get('sim')
    ?? (import.meta.env as unknown as Record<string, string | undefined>).VITE_FORCE_SIM
  if (simName) {
    const { applyFixture } = await import('./sim/fixtures')
    if (!applyFixture(simName)) await seedFromHub() // unknown fixture → fall back to live
  } else {
    await seedFromHub()
  }

  // even-toolkit's useGlasses hook calls useLocation() internally, so the app must
  // live under a Router even though the cockpit does its own state-driven routing.
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}

void boot()
