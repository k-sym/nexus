import type { ChatEngine, EngineId, EngineModel } from './types.js';

export interface ResolvedModel {
  engine: ChatEngine;
  model: EngineModel;
}

/**
 * Owns every registered engine. Model keys are `provider/id`; the first engine
 * whose catalog knows the pair wins, so providers must not overlap (Pi's
 * `anthropic` vs the Claude engine's `claude-code` are distinct on purpose).
 */
export class EngineRegistry {
  constructor(private readonly engines: ChatEngine[]) {}

  get(id: EngineId): ChatEngine | undefined {
    return this.engines.find((engine) => engine.id === id);
  }

  listModels(): EngineModel[] {
    return this.engines.flatMap((engine) => engine.listModels());
  }

  resolveModel(modelKey: string): ResolvedModel | undefined {
    const sep = modelKey.indexOf('/');
    if (sep <= 0) return undefined;
    const provider = modelKey.slice(0, sep);
    const id = modelKey.slice(sep + 1);
    for (const engine of this.engines) {
      const model = engine.findModel(provider, id);
      if (model) return { engine, model };
    }
    return undefined;
  }
}
