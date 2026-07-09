import type { Approval, ConnectionStatus, SessionSummary, TranscriptEvent } from '../types'

// Immutable snapshot of the cockpit state the glasses render. Built from the
// shared store on every change (see AppGlasses.tsx). Identity changes only when
// state changes, so useGlasses' 100ms poll only redraws the HUD when needed.
export interface GlassSnapshot {
  connection: ConnectionStatus
  armed: boolean
  sessions: SessionSummary[]
  approvals: Approval[]          // pending only; a non-empty queue takes over the HUD
  activeSessionId: string | null // set => detail screen
  activeEvents: TranscriptEvent[]
  detailPage: number             // Phase 2: page of the latest reply shown on the detail card
  error: string | null
  dismissedAttentionKey: string | null // attention set the user already acknowledged
  listening: boolean                   // Phase 4b: mic open for a voice answer
  steering: boolean                    // Phase 4c: mic open for a free-text steer (detail screen)
  interim: string                      // live transcript while listening/steering
}

// Side effects a screen can trigger in response to a gesture. Implemented in
// AppGlasses.tsx against the hub API.
export interface GlassActions {
  toggleArmed(): void
  openSession(id: string): void
  closeDetail(): void
  allow(id: string): void
  deny(id: string): void
  dismissInterrupt(key: string): void
}
