import { realpathSync, unlinkSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppContext } from "./context.js";
import { removeFile } from "./sync/ingest.js";

export type MaintenanceName = "rebuild" | "clear";

export class MaintenanceCoordinator {
  private maintenance: MaintenanceName | null = null;
  private activeWorkers = 0;
  private workersDrained: Promise<void> = Promise.resolve();
  private resolveWorkersDrained: (() => void) | null = null;
  private maintenanceFinished: Promise<void> = Promise.resolve();
  private resolveMaintenanceFinished: (() => void) | null = null;

  async runMutation<T>(work: () => Promise<T>): Promise<T> {
    while (this.maintenance) await this.maintenanceFinished;
    if (this.activeWorkers++ === 0) {
      this.workersDrained = new Promise<void>((resolve) => { this.resolveWorkersDrained = resolve; });
    }
    try {
      return await work();
    } finally {
      if (--this.activeWorkers === 0) {
        this.resolveWorkersDrained?.();
        this.resolveWorkersDrained = null;
      }
    }
  }

  async runWorker<T>(work: () => Promise<T>): Promise<T> {
    return this.runMutation(work);
  }

  async runMaintenance<T>(
    name: MaintenanceName,
    work: () => Promise<T> | T,
  ): Promise<{ acquired: true; value: T } | { acquired: false; running: MaintenanceName }> {
    if (this.maintenance) return { acquired: false, running: this.maintenance };
    this.maintenance = name;
    this.maintenanceFinished = new Promise<void>((resolve) => { this.resolveMaintenanceFinished = resolve; });
    try {
      await this.workersDrained;
      return { acquired: true, value: await work() };
    } finally {
      this.maintenance = null;
      this.resolveMaintenanceFinished?.();
      this.resolveMaintenanceFinished = null;
    }
  }
}

const coordinators = new WeakMap<AppContext, MaintenanceCoordinator>();

export function maintenanceCoordinatorFor(ctx: AppContext): MaintenanceCoordinator {
  let coordinator = coordinators.get(ctx);
  if (!coordinator) {
    coordinator = new MaintenanceCoordinator();
    coordinators.set(ctx, coordinator);
  }
  return coordinator;
}

export interface ClearNexusFailure {
  path: string;
  error: string;
}

export interface ClearNexusResult {
  namespace: "nexus";
  deleted: number;
  failed: number;
  paths: string[];
  failures: ClearNexusFailure[];
}

export function clearNexusMemory(ctx: AppContext): ClearNexusResult {
  const rows = ctx.db.prepare(
    "SELECT file_path FROM memories WHERE namespace = 'nexus' AND deleted_at IS NULL ORDER BY file_path",
  ).all() as Array<{ file_path: string }>;
  const result: ClearNexusResult = {
    namespace: "nexus",
    deleted: 0,
    failed: 0,
    paths: [],
    failures: [],
  };
  const vaultPath = resolve(ctx.cfg.vaultPath);
  const vaultRealPath = realpathSync(vaultPath);

  for (const row of rows) {
    const resolvedPath = resolve(row.file_path);
    const lexicalRelative = relative(vaultPath, resolvedPath);
    const reportPath = lexicalRelative && !lexicalRelative.startsWith(`..${sep}`) && lexicalRelative !== ".." && !isAbsolute(lexicalRelative)
      ? lexicalRelative
      : basename(resolvedPath);
    try {
      const realPath = realpathSync(resolvedPath);
      const vaultRelative = relative(vaultRealPath, realPath);
      const insideVault = vaultRelative.length > 0
        && vaultRelative !== ".."
        && !vaultRelative.startsWith(`..${sep}`)
        && !isAbsolute(vaultRelative);
      if (!insideVault || extname(realPath).toLowerCase() !== ".md") {
        result.failed++;
        result.failures.push({ path: reportPath, error: "Refusing to delete a path outside the canonical Markdown vault" });
        continue;
      }
      unlinkSync(row.file_path);
      removeFile(ctx, row.file_path);
      result.deleted++;
      result.paths.push(vaultRelative);
    } catch (error) {
      result.failed++;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
      result.failures.push({ path: reportPath, error: `Unable to delete canonical memory (${code})` });
    }
  }

  return result;
}
