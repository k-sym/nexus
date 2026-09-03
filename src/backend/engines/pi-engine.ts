import type { PiRuntime } from '../pi/runtime.js';
import type { ChatEngine, EngineModel, EngineSession } from './types.js';

type PiRuntimeSurface = Pick<PiRuntime, 'models' | 'sessionFor' | 'hasSession' | 'dropSession'>;

export interface PiEngineOptions {
  /** Models to withhold from the catalog and from lookup (e.g. Pi's Anthropic
   *  OAuth models while the Claude engine owns Anthropic). Read per call. */
  isHidden?: (model: EngineModel) => boolean;
}

/** The existing Pi runtime behind the engine contract. Zero behaviour change. */
export class PiEngine implements ChatEngine {
  readonly id = 'pi' as const;

  constructor(private readonly pi: PiRuntimeSurface, private readonly options: PiEngineOptions = {}) {}

  listModels(): EngineModel[] {
    const available = new Set(this.pi.models.getAvailable().map((m) => `${m.provider}/${m.id}`));
    return this.pi.models.getAll().map((m) => ({
      ...(m as unknown as EngineModel),
      configured: available.has(`${m.provider}/${m.id}`),
    })).filter((m) => !this.options.isHidden?.(m));
  }

  /** Returns Pi's own `Model` object (widened): `AgentSession.setModel` needs the real instance. */
  findModel(provider: string, id: string): EngineModel | undefined {
    const model = this.pi.models.find(provider, id) as unknown as EngineModel | undefined;
    if (model && this.options.isHidden?.(model)) return undefined;
    return model;
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
