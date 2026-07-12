import { useState } from 'react'
import { checkHealth } from '../api'
import { store, useStore } from '../store'

export function Connect() {
  const savedUrl = useStore(s => s.baseUrl)
  const [url, setUrl] = useState(savedUrl || 'http://127.0.0.1:8899')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function connect() {
    setBusy(true); setMsg(null)
    const res = await checkHealth(url)
    setBusy(false)
    if (!res.ok) { setMsg(`Can't reach hub: ${res.reason}`); return }
    store.setCredentials(url, token)
  }

  return (
    <div className="card">
      <h2>Connect to hub</h2>
      <label>Hub URL
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:8899" />
      </label>
      <label>Token <span className="muted">(blank for dev / no-auth)</span>
        <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="HUB_TOKEN" />
      </label>
      <div className="connect-actions">
        <button onClick={connect} disabled={busy}>{busy ? 'Checking…' : 'Connect'}</button>
        {/* Only offer Cancel when there's already a saved hub to fall back to
            (i.e. arrived here via "Change hub", not the first-run empty state). */}
        {savedUrl && <button className="cancel" onClick={() => store.closeConnect()} disabled={busy}>Cancel</button>}
      </div>
      {msg && <p className="err">{msg}</p>}
    </div>
  )
}
