import type { PiRuntime } from '../pi/runtime.js';
import type { ChatEngine, EngineModel, EngineSession } from './types.js';

type PiRuntimeSurface = Pick<PiRuntime, 'models' | 'sessionFor' | 'hasSession' | 'dropSession'>;

/** The existing Pi runtime behind the engine contract. Zero behaviour change. */
export class PiEngine implements ChatEngine {
  readonly id = 'pi' as const;

  constructor(private readonly pi: PiRuntimeSurface) {}

  listModels(): EngineModel[] {
    const available = new Set(this.pi.models.getAvailable().map((m) => `${m.provider}/${m.id}`));
    return this.pi.models.getAll().map((m) => ({
      ...(m as unknown as EngineModel),
      configured: available.has(`${m.provider}/${m.id}`),
    }));
  }

  /** Returns Pi's own `Model` object (widened): `AgentSession.setModel` needs the real instance. */
  findModel(provider: string, id: string): EngineModel | undefined {
    return this.pi.models.find(provider, id) as unknown as EngineModel | undefined;
  }

  sessionFor(threadId: string, cwd: string): Promise<EngineSession> {
    return this.pi.sessionFor(threadId, cwd) as Promise<EngineSession>;
  }

  hasSession(threadId: string, cwd: string): boolean {
    return this.pi.hasSession(threadId, cwd);
  }

  dropSession(threadId: string, cwd: string): void {
    this.pi.dropSession(threadId, cwd);
  }
}
