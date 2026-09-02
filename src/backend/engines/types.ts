/**
 * Engine contracts.
 *
 * An engine produces chat sessions that speak Pi's `AgentSessionEvent`
 * vocabulary and persist Pi-shaped entries into the thread's JSONL via Pi's
 * `SessionManager`. Nothing downstream of the chat route (NDJSON stream,
 * `flattenEntries`, the frontend reducer, iOS, archive) knows which engine
 * produced a turn — that is the whole point of the seam.
 */
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '../pi/thinking.js';

export type EngineId = 'pi' | 'claude-code';

/** Wire-compatible with Pi's session events; engines must emit exactly this shape. */
export type EngineSessionEvent = AgentSessionEvent;

/** The catalog shape the models route, curation and capability resolver consume. */
export interface EngineModel {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  /** Pi's per-level override map; `getSupportedThinkingLevels` reads it. */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  /** False when the engine cannot reach this model with the current auth. */
  configured?: boolean;
}

/**
 * What the chat route needs from a session. Pi's `AgentSession` satisfies it
 * structurally; the Claude engine implements it directly. `setModel` takes the
 * engine's own model object (Pi needs its real `Model`, Claude an `EngineModel`).
 */
export type EngineSession = Pick<
  AgentSession,
  'subscribe' | 'prompt' | 'abort' | 'getContextUsage' | 'setThinkingLevel' | 'supportsThinking'
> & {
  setModel(model: any): Promise<void>;
  sessionManager?: Pick<AgentSession['sessionManager'], 'appendCustomEntry' | 'getLeafId' | 'getLeafEntry' | 'getEntries'>;
};

export interface ChatEngine {
  readonly id: EngineId;
  listModels(): EngineModel[];
  findModel(provider: string, id: string): EngineModel | undefined;
  sessionFor(threadId: string, cwd: string): Promise<EngineSession>;
  hasSession(threadId: string, cwd: string): boolean;
  dropSession(threadId: string, cwd: string): void;
}
