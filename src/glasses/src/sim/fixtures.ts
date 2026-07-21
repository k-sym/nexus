// Simulator fixtures — seed the cockpit store with canned scenarios so the G2 HUD
// renders a known screen WITHOUT a live gateway. Activated by `?sim=<name>` (see
// main.tsx), which lazy-imports this module (kept out of the production bundle)
// and skips HubFeed so nothing overwrites the seed. Drive the rendered HUD with
// the evenhub-simulator automation API (scripts/sim.sh) to capture screenshots.
import { store } from '../store'
import type { Approval, SessionSummary } from '../types'

const now = Date.now()

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: over.id,
    title: over.title ?? 'session',
    cwd: over.cwd ?? '/Users/dev/project',
    project: over.project ?? 'project',
    projectBadge: over.projectBadge,
    lastPrompt: '',
    lastAssistant: '',
    lastActivityAt: over.lastActivityAt ?? now,
    turns: over.turns ?? 0,
    live: over.live ?? false,
    recent: over.recent ?? true,
    needsAttention: over.needsAttention ?? false,
    attention: over.attention ?? null,
  }
}

// A realistic multi-paragraph assistant reply — long enough to paginate to a few
// pages at DETAIL_COLS×DETAIL_ROWS, so the detail card shows the "latest reply
// only" paging (goal 1).
const LONG_REPLY =
  'I wired the QuestionBroker to push pending and resolved events the instant a ' +
  'question registers or resolves, then dropped the one-second poll-diff timer in ' +
  'the gateway entirely. The session list now lights up the moment a session needs ' +
  'input, instead of waiting up to a full second for the next diff tick. ' +
  'On the glasses side, the detail card no longer caps the transcript at about 420 ' +
  'characters — it shows the latest assistant reply in full, paginated, and you ' +
  'scroll to page through it while tap still steers and double-tap still backs out. ' +
  'I also added tests covering the broker emitter across the answer, deny, cancel, ' +
  'and abort paths, and verified the pagination against the real toolkit package.'

/** Seed the store for a named scenario. Returns false for an unknown name. */
export function applyFixture(name: string): boolean {
  // Dummy baseUrl so <App> renders past the Connect screen; sim mode skips HubFeed.
  store.setCredentials('http://sim.local', '')
  // Design-lab mockups (?sim=lab-*) and the navigable prototype (?sim=p3) render
  // their own bitmaps in <Lab>/<Phase3App>; no store seeding — just claim the name
  // so boot() skips the live seed.
  if (name.startsWith('lab-') || name === 'p3' || name === 'fw' || name === 'glyphs') return true

  switch (name) {
    case 'detail-long': {
      const s = session({ id: 'demo', title: 'nexus · gateway', project: 'nexus', live: true, turns: 5 })
      store.set({ sessions: [s], approvals: [], connection: 'ok' })
      store.openDetail(s.id, [
        { kind: 'user', text: 'add the simulator to the toolchain so we can screenshot' },
        { kind: 'tool_use', name: 'Bash', input: { command: 'npm i -D @evenrealities/evenhub-simulator' } },
        { kind: 'assistant_text', text: LONG_REPLY },
      ])
      return true
    }
    case 'approval': {
      // A supervised tool gate — the third takeover screen, and the one with no live
      // path to reach it without turning Supervise on.
      const s = session({ id: 'demo', title: 'nexus · gateway', project: 'nexus', live: true })
      const gate: Approval = {
        id: 'gate-1', kind: 'approval', session_id: s.id,
        tool_name: 'Bash', tool_input: { command: 'rm -rf dist && npm run build:glasses && npm --prefix src/glasses run pack' },
        cwd: '/Users/dev/Projects/nexus', title: 'run a shell command',
        createdAt: now, decision: null,
      }
      store.set({ sessions: [s], approvals: [gate], connection: 'ok' })
      return true
    }
    case 'detail-working': {
      // The mid-tool state the live gateway rarely holds still for: a previous reply
      // (in Markdown, to exercise the flattener) with tool calls after it, so the
      // detail body shows the live activity line above the last thing it said.
      const s = session({ id: 'demo', title: 'A very long session title that will not fit the header bar', project: 'nexus', live: true, turns: 9 })
      store.set({ sessions: [s], approvals: [], connection: 'ok' })
      store.openDetail(s.id, [
        { kind: 'user', text: 'find where the glasses app lives' },
        { kind: 'assistant_text', text: 'Yes! I can see the **glasses app** at `apps/even-glasses/`.\n\nIt has a `run.sh`, a `shim/` directory, launchd configs and a LiteLLM config. Want me to dig into anything *specific*?' },
        { kind: 'tool_use', name: 'Read', input: { file_path: '/Users/dev/project/apps/even-glasses/run.sh' } },
        { kind: 'tool_use', name: 'Bash', input: { command: 'npm --prefix src/glasses run build && npm test' } },
      ])
      return true
    }
    case 'detail-short': {
      const s = session({ id: 'demo', title: 'nexus · gateway', project: 'nexus', live: true, turns: 3 })
      store.set({ sessions: [s], approvals: [], connection: 'ok' })
      store.openDetail(s.id, [
        { kind: 'assistant_text', text: 'Done — pushed the fix and all 107 tests pass.' },
      ])
      return true
    }
    case 'list': {
      store.set({
        connection: 'ok', approvals: [], activeSessionId: null, activeEvents: [],
        // Pre-dismiss the attention interrupt so the LIST (with its ●/◐/○ dots) shows
        // instead of the pushed "needs you" hero. Key = sorted needs-attention ids.
        dismissedAttentionKey: 's1',
        sessions: [
          session({ id: 's1', title: 'nexus · gateway', project: 'nexus', projectBadge: 'NEX', live: true, needsAttention: true, attention: { type: 'agent_needs_input', message: 'Waiting for your answer' }, lastActivityAt: now - 4_000 }),
          session({ id: 's2', title: 'baker · api', project: 'Baker Internal', projectBadge: 'BAK', live: true, lastActivityAt: now - 90_000 }),
          session({ id: 's3', title: 'docs · site', project: 'docs', projectBadge: 'DOC', live: false, recent: true, lastActivityAt: now - 3_600_000 }),
        ],
      })
      return true
    }
    case 'question': {
      // A configured STT key surfaces the "● Speak answer" row on the question screen.
      localStorage.setItem('cockpit.sttProvider', 'deepgram')
      localStorage.setItem('cockpit.sttKey', 'sim-demo-key')
      const s = session({ id: 's1', title: 'nexus · gateway', project: 'nexus', live: true, needsAttention: true, attention: { type: 'agent_needs_input', message: 'Waiting for your answer' } })
      const approval: Approval = {
        id: 'call-1', kind: 'question', session_id: 's1', tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which transcript UX should the detail card use?', header: 'Transcript', options: [{ label: 'Latest reply only' }, { label: 'Scroll-to-page' }, { label: 'Per-turn list' }] }] },
        cwd: '/Users/dev/nexus', title: 'Transcript', createdAt: now, decision: null,
      }
      store.set({ sessions: [s], approvals: [approval], activeSessionId: null, activeEvents: [] })
      return true
    }
    case 'question-multi': {
      // Two questions — the second allows a free-text ("Other") answer. Exercises the
      // multi-question answer flow (every question must be answered before submit, #179)
      // and the allowOther custom path (#178). STT key on so the HUD's "Speak answer" shows.
      localStorage.setItem('cockpit.sttProvider', 'deepgram')
      localStorage.setItem('cockpit.sttKey', 'sim-demo-key')
      const s = session({ id: 's1', title: 'nexus · gateway', project: 'nexus', live: true, needsAttention: true, attention: { type: 'agent_needs_input', message: 'Waiting for your answer' } })
      const approval: Approval = {
        id: 'call-2', kind: 'question', session_id: 's1', tool_name: 'AskUserQuestion',
        tool_input: { questions: [
          { question: 'Ship the gateway fix to prod now?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'No' }] },
          { question: 'When should it go out?', header: 'Timing', allowOther: true, options: [{ label: 'Now' }, { label: 'Tonight' }] },
        ] },
        cwd: '/Users/dev/nexus', title: 'Deploy', createdAt: now, decision: null,
      }
      store.set({ sessions: [s], approvals: [approval], activeSessionId: null, activeEvents: [] })
      return true
    }
    default:
      return false
  }
}
