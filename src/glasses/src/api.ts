import { store } from './store'
import type { Approval, SessionDetail, SessionSummary, SseEvent } from './types'

function creds() {
  const { baseUrl, token } = store.getState()
  if (!baseUrl) throw new Error('not configured')
  return { baseUrl, token }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, token } = creds()
  const headers = new Headers(init.headers ?? {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetch(baseUrl + path, { ...init, headers })
}

export interface HealthResult { ok: boolean; reason?: string; armed?: boolean }

export async function checkHealth(baseUrl: string): Promise<HealthResult> {
  const url = baseUrl.replace(/\/$/, '') + '/api/health'
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const body = await res.json() as { ok: boolean; armed: boolean }
    return { ok: true, armed: body.armed }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Fetch the session catalog. `scope` picks the hub-side filter:
 *   'active' — only sessions backed by a live process (or that need you)
 *   'recent' — active within the hub's RECENT_MS window (or that need you)
 *   'all'    — everything on disk (default)
 */
export async function getSessions(scope: 'active' | 'recent' | 'all' = 'all'): Promise<SessionSummary[]> {
  const qs = scope === 'all' ? '' : `?scope=${scope}`
  const res = await api(`/api/sessions${qs}`)
  if (!res.ok) throw new Error(`getSessions: ${res.status}`)
  return (await res.json() as { sessions: SessionSummary[] }).sessions
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`getSession: ${res.status}`)
  return res.json()
}

export async function getPending(): Promise<Approval[]> {
  const res = await api('/api/approvals')
  if (!res.ok) throw new Error(`getPending: ${res.status}`)
  return (await res.json() as { approvals: Approval[] }).approvals
}

/** STT (voice) config Nexus serves from ~/.nexus/config.yaml gateway.stt. */
export interface CockpitConfig { stt?: { provider?: string; apiKey?: string; language?: string } }
export async function getCockpitConfig(): Promise<CockpitConfig | null> {
  const res = await api('/api/cockpit-config')
  if (!res.ok) return null
  return res.json() as Promise<CockpitConfig>
}

export async function setArmed(armed: boolean, ttlSec?: number): Promise<void> {
  const res = await api('/api/arm', { method: 'POST', body: JSON.stringify({ armed, ttlSec }) })
  if (!res.ok) throw new Error(`arm: ${res.status}`)
}

export async function decide(id: string, action: 'allow' | 'deny', reason?: string): Promise<void> {
  const res = await api(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ action, reason }),
  })
  if (!res.ok) throw new Error(`decide: ${res.status}`)
}

/**
 * Answer an AskUserQuestion. `answers` maps each question's exact text to the chosen
 * label (or free-text). The hook turns this into updatedInput so Claude Code runs the
 * tool as if the user answered in-app. `reason` is a human-readable summary for the log.
 */
export async function answer(id: string, answers: Record<string, string>, reason?: string): Promise<void> {
  const res = await api(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ action: 'answer', answers, reason }),
  })
  if (!res.ok) throw new Error(`answer: ${res.status}`)
}

/**
 * Phase 4c: send a free-text steer to a session. It's delivered to that session's
 * parked Stop hook (injected as its next instruction) if one is waiting, else queued
 * for its next turn end. Only the focused session parks (see setSteerFocus).
 */
export async function sendSteer(id: string, message: string): Promise<{ accepted: boolean }> {
  const res = await api(`/api/steer/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ message }) })
  if (!res.ok) throw new Error(`steer: ${res.status}`)
  const body = await res.json().catch(() => ({})) as { ok?: boolean; armed?: boolean }
  return { accepted: body.ok === true } // false when the hub is disarmed (safe-by-default)
}

/**
 * Set (or clear, with null) the session armed to "park" its Stop hook — i.e. hold its
 * turn open waiting for a steer. Set when a session's detail opens on the glasses so
 * only that one session parks; cleared when you navigate away, so nothing else locks.
 */
export async function setSteerFocus(id: string | null): Promise<void> {
  const res = await api('/api/steer/focus', { method: 'POST', body: JSON.stringify({ session_id: id }) })
  if (!res.ok) throw new Error(`steerFocus: ${res.status}`)
}

/** Subscribe to the hub SSE stream. Returns an unsubscribe fn. */
export function connectEvents(onEvent: (e: SseEvent) => void, onStatus: (ok: boolean) => void): () => void {
  const { baseUrl, token } = creds()
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  const es = new EventSource(baseUrl + '/api/events' + qs)
  es.onopen = () => onStatus(true)
  es.onerror = () => onStatus(false)
  es.onmessage = (ev) => {
    try { onEvent(JSON.parse(ev.data) as SseEvent) } catch { /* ignore heartbeats/partials */ }
  }
  return () => es.close()
}
