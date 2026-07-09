// Speech-to-text config + answer matching for the glasses question screen (Phase 4b).
//
// The voice answer flows: glasses mic → even-toolkit STTEngine (GlassBridgeSource) →
// transcript text → matchAnswer() → the chosen option label (or free-text "Other").
//
// Backend is CONFIG-DRIVEN. Default = Deepgram (streaming, live interim transcript,
// ~$0.0065/min); swap to a local/offline backend via config. Cloud built-ins need an
// API key; with none set, voice is disabled and the question screen falls back to
// tap-to-pick (which always works).

export interface SttConfig {
  provider: string   // 'deepgram' | 'soniox' | 'whisper-api' | (custom)
  apiKey: string
  language: string
  enabled: boolean   // false => hide the voice affordance, tap-to-pick only
}

// Providers that talk to a cloud endpoint and therefore require a key.
const NEEDS_KEY = new Set(['deepgram', 'soniox', 'whisper-api'])

/**
 * Resolve STT config at call time (browser only — reads import.meta.env + localStorage).
 * Precedence: localStorage override > Vite env > default. localStorage lets you set a
 * key/provider on-device (e.g. from the QR-loaded app) without a rebuild.
 */
export function sttConfig(): SttConfig {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {}
  const ls = (k: string) => { try { return localStorage.getItem(k) || '' } catch { return '' } }
  const provider = ls('cockpit.sttProvider') || env.VITE_STT_PROVIDER || 'deepgram'
  const apiKey = ls('cockpit.sttKey') || env.VITE_STT_API_KEY || ''
  const language = env.VITE_STT_LANGUAGE || 'en'
  const enabled = !NEEDS_KEY.has(provider) || !!apiKey
  return { provider, apiKey, language, enabled }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']
// Spoken numbers arrive as WORDS from STT ("option two"), not digits — map them.
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * Map a spoken transcript to one of the question's option labels, or return the raw
 * transcript as a free-text ("Other") answer when nothing matches. Handles: an exact
 * label, "option N" / "number N" / a bare digit, ordinal words ("the second one"), and
 * label/transcript containment ("let's go with staging" → "Staging").
 */
export function matchAnswer(transcript: string, options: string[]): string {
  const raw = transcript.trim()
  if (!raw) return ''
  const nt = norm(raw)

  // 1) exact (normalized) label
  for (const o of options) if (norm(o) === nt) return o

  // 2) the whole utterance is "[option|number|choice] N", N a digit or number-word
  //    ("option two", "number 1", bare "two"). Anchored so it doesn't fire on the
  //    trailing "one" of "the second one" (that's the ordinal rule below).
  const num = nt.match(/^(?:option |number |choice )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/)
  if (num) { const n = /^\d/.test(num[1]) ? Number(num[1]) : WORD_NUM[num[1]]; const i = n - 1; if (i >= 0 && i < options.length) return options[i] }

  // 3) ordinal word anywhere ("the second one")
  for (let i = 0; i < options.length && i < ORDINALS.length; i++) {
    const re = new RegExp(`\\b${ORDINALS[i]}\\b`)
    if (re.test(nt)) return options[i]
  }

  // 4) label contained in the transcript, or the transcript inside a label
  for (const o of options) {
    const no = norm(o)
    if (no && (nt.includes(no) || no.includes(nt))) return o
  }

  // 5) no match → free-text answer (AskUserQuestion's built-in "Other" path)
  return raw
}
