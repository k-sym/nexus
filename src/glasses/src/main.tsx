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
function seedFromHub() {
  const params = new URLSearchParams(window.location.search)
  const hub = params.get('hub')
  // Seed the hub once, when nothing is stored yet. Prefer an explicit ?hub=,
  // but otherwise default to the origin that served this app: when Nexus hosts
  // the cockpit, the gateway API is same-origin, so the Even app just needs to
  // load `https://<host>:<port>/` with no query param (which sidesteps the
  // "URL inside a URL" the Even loader rejects). A wrong guess is harmless —
  // the health check fails and the Connect screen lets you correct it.
  if (!store.getState().baseUrl) {
    store.setCredentials(hub || window.location.origin, params.get('token') ?? '')
  }
  const stt = params.get('stt'); if (stt) localStorage.setItem('cockpit.sttProvider', stt)
  const sttKey = params.get('sttKey'); if (sttKey) localStorage.setItem('cockpit.sttKey', sttKey)

  // Pull STT from Nexus (GET /api/cockpit-config) so the key lives in
  // ~/.nexus/config.yaml, not the client. A ?stt= param this load overrides it;
  // otherwise Nexus config wins over any stale localStorage. Best-effort + async,
  // but resolves long before the user opens a session and taps Steer.
  if (!stt && !sttKey) {
    const base = store.getState().baseUrl
    const token = store.getState().token
    fetch(`${base}/api/cockpit-config${token ? `?token=${encodeURIComponent(token)}` : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        const s = cfg?.stt
        if (s?.apiKey) {
          localStorage.setItem('cockpit.sttProvider', s.provider || 'deepgram')
          localStorage.setItem('cockpit.sttKey', s.apiKey)
        }
      })
      .catch(() => { /* voice stays off until configured */ })
  }
}

// `?sim=<scenario>` seeds a canned HUD screen for the evenhub-simulator (no live
// gateway). Lazy-imported so the fixtures stay out of the production bundle;
// <App> then skips HubFeed so nothing overwrites the seed.
async function boot() {
  const simName = new URLSearchParams(window.location.search).get('sim')
    ?? (import.meta.env as unknown as Record<string, string | undefined>).VITE_FORCE_SIM
  if (simName) {
    const { applyFixture } = await import('./sim/fixtures')
    if (!applyFixture(simName)) seedFromHub() // unknown fixture → fall back to live
  } else {
    seedFromHub()
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
