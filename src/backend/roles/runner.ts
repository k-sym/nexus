import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { ROLE_NAMES, type RolesConfig, type RoleName } from '@nexus/shared';
import type Database from 'better-sqlite3';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { EngineRegistry } from '../engines/registry.js';
import type { EngineSession } from '../engines/types.js';
import type { ConcurrencyTracker } from '../pi/concurrency.js';
import type { ActivityBus } from '../activity/events.js';
import { readOverrides } from './config.js';
import { ROLE_TOOLS, ROLE_PURPOSES } from './definitions.js';
interface Parent { threadId: string; projectId: string; cwd: string; runId: string; owner: symbol; signal: AbortSignal; onQuestion?: (event: any) => void; onRole?: (event: any) => void; }
export class RoleRunner {
  private parents = new Map<string, Parent>();
  private parentTools = new Map<string, Set<string>>();
  isBusy(threadId: string): boolean { return this.pending.has(threadId); }
  private pending = new Map<string, Promise<unknown>>();
  constructor(private deps: { db: Database.Database; engines: EngineRegistry; concurrency: ConcurrencyTracker; config: RolesConfig; bus?: ActivityBus }) {
    if (deps.config.enabled) deps.db.prepare("UPDATE role_runs SET status = 'interrupted', completed_at = ? WHERE status = 'running'").run(new Date().toISOString());
  }
  bind(parent: Omit<Parent, 'signal'>, session: EngineSession): () => Promise<void> {
    const controller = new AbortController();
    this.parents.set(parent.threadId, { ...parent, signal: controller.signal });
    const activeTools = new Set<string>();
    this.parentTools.set(parent.threadId, activeTools);
    const unsubscribe = session.subscribe?.(event => {
      if (event.type === 'tool_execution_start') activeTools.add(event.toolCallId);
      if (event.type === 'tool_execution_end') activeTools.delete(event.toolCallId);
    });
    const original = session.abort;
    session.abort = async () => { controller.abort(); await original.call(session); };
    return async () => {
      controller.abort();
      await this.pending.get(parent.threadId)?.catch(() => {});
      unsubscribe?.();
      this.parentTools.delete(parent.threadId);
      this.parents.delete(parent.threadId);
      session.abort = original;
    };
  }
  factories(threadId: string): ExtensionFactory[] {
    if (!this.deps.config.enabled) return [];
    return [api => { for (const role of ROLE_NAMES) api.registerTool({
      name: ROLE_TOOLS[role], label: role, executionMode: 'sequential', description: ROLE_PURPOSES[role],
      parameters: Type.Object({ brief: Type.String({ minLength: 1, maxLength: 32000 }), files: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 })) }),
      execute: async (callId, args, signal) => {
        const parent = this.parents.get(threadId);
        if (!parent || parent.signal.aborted) throw new Error('Roles require an active parent run');
        if (this.pending.has(threadId)) throw new Error('A role is already running; await its report before calling another');
        if ([...(this.parentTools.get(threadId) ?? [])].some(id => id !== callId)) throw new Error('Call a role on its own, after the parent’s other tool calls finish');
        const promise = this.deps.concurrency.runAsChild(parent.projectId, parent.owner, () => this.run(parent, role, callId, args, signal));
        this.pending.set(threadId, promise);
        try { return await promise; } finally { this.pending.delete(threadId); }
      },
    }); }];
  }
  private async run(parent: Parent, role: RoleName, callId: string, args: { brief: string; files?: string[] }, signal?: AbortSignal) {
    const row = this.deps.db.prepare('SELECT role_models FROM chat_threads WHERE id = ?').get(parent.threadId) as { role_models: string | null };
    const modelKey = readOverrides(row?.role_models, `thread ${parent.threadId}`)[role] ?? this.deps.config.models[role];
    const resolved = this.deps.engines.resolveModel(modelKey);
    if (!resolved || !resolved.engine.createChildSession || !this.deps.engines.listModels().some(m => `${m.provider}/${m.id}` === modelKey && m.configured !== false)) throw new Error(`${role} model unavailable: ${modelKey}`);
    const id = randomUUID(), start = Date.now();
    const diagnostics = { role, parentRunId: parent.runId, parentToolCallId: callId, childRunId: id };
    this.deps.db.prepare('INSERT INTO role_runs (id, parent_run_id, parent_tool_call_id, thread_id, role, model_key, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, parent.runId, callId, parent.threadId, role, modelKey, 'running', new Date(start).toISOString());
    const activity = { operationId: id, kind: 'chat_turn' as const, title: `${role[0].toUpperCase() + role.slice(1)} · ${modelKey}`, threadId: parent.threadId, projectId: parent.projectId, provider: resolved.model.provider, model: resolved.model.id, diagnostics };
    this.deps.bus?.emit({ ...activity, type: 'start' });
    parent.onRole?.({ type: 'tool_execution_update', toolCallId: callId, toolName: ROLE_TOOLS[role], partialResult: { content: [], details: { childRunId: id, role, model: modelKey, tokens: 0, durationMs: 0, status: 'running' } } });
    let child: (EngineSession & { dispose?: () => void }) | undefined;
    let reason = '', report = '', tokens = 0, turns = 0;
    let unsubscribe: (() => void) | undefined;
    const combined = signal ? AbortSignal.any([signal, parent.signal]) : parent.signal;
    const stop = (why: string) => {
      reason ||= why;
      this.deps.bus?.emit({ ...activity, type: 'update', lastEvent: 'cancelling', error: `${reason}; waiting for the child to stop before releasing the project` });
      void child?.abort().catch(error => {
        this.deps.bus?.emit({ ...activity, type: 'update', lastEvent: 'cancellation_failed', error: `Child cancellation failed; project remains locked: ${String(error)}` });
      });
    };
    const onAbort = () => stop('Parent or tool call cancelled');
    combined.addEventListener('abort', onAbort, { once: true });
    // Time waiting on a human for a forwarded question is not the child's work,
    // so the ceiling clock pauses while one is pending (#500). The question's own
    // expiry and the parent's abort still bound the wait.
    let remainingMs = this.deps.config.max_minutes * 60000, clockStart = Date.now(), pendingQuestions = 0;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => stop('Time ceiling reached'), remainingMs);
    const pauseClock = () => {
      if (pendingQuestions++ > 0 || !timer) return;
      clearTimeout(timer); timer = undefined;
      remainingMs = Math.max(0, remainingMs - (Date.now() - clockStart));
    };
    const resumeClock = () => {
      if (pendingQuestions === 0 || --pendingQuestions > 0 || reason) return;
      clockStart = Date.now();
      timer = setTimeout(() => stop('Time ceiling reached'), remainingMs);
    };
    try {
      child = await resolved.engine.createChildSession({ id, parentThreadId: parent.threadId, parentToolCallId: callId, cwd: parent.cwd, role, prompt: `You are the Nexus ${role}. ${ROLE_PURPOSES[role]}\nWork only on the supplied brief. You cannot delegate. Finish with a concise report and verification evidence.` });
      await child.setModel(resolved.model);
      unsubscribe = child.subscribe(event => {
        if ((event.type === 'tool_execution_start' || event.type === 'tool_execution_end') && event.toolName === 'question') {
          const mapped = event.type === 'tool_execution_start' ? { ...event, args: { ...event.args, questions: event.args.questions?.map((q: any) => ({ ...q, header: `${role[0].toUpperCase() + role.slice(1)} · ${q.header}` })) } } : event;
          parent.onQuestion?.(mapped);
          if (event.type === 'tool_execution_start') pauseClock(); else resumeClock();
        }
        if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
        turns++;
        const message = event.message;
        report = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || report;
        tokens += message.usage?.totalTokens ?? 0;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') reason ||= message.errorMessage || message.stopReason;
        if (turns >= this.deps.config.max_turns) stop('Turn ceiling reached');
        if (tokens >= this.deps.config.max_tokens) stop('Token ceiling reached');
      });
      if (combined.aborted || reason) stop(reason || 'Parent cancelled');
      else await child.prompt(`${args.brief}\n${args.files?.length ? `Relevant files:\n${args.files.join('\n')}` : ''}`);
    } catch (error) { reason ||= error instanceof Error ? error.message : String(error); }
    finally {
      if (timer) clearTimeout(timer);
      combined.removeEventListener('abort', onAbort); unsubscribe?.();
      try { child?.dispose?.(); } catch (error) { reason ||= `Child cleanup failed: ${String(error)}`; }
    }
    if (!report.trim()) reason ||= 'Child returned no report';
    const status = reason ? 'incomplete' : 'completed';
    const durationMs = Date.now() - start;
    report = `${reason ? `INCOMPLETE: ${reason}\n\n` : ''}${report || 'No report returned.'}`;
    this.deps.db.prepare('UPDATE role_runs SET status = ?, report = ?, tokens = ?, completed_at = ?, duration_ms = ? WHERE id = ?').run(status, report, tokens, new Date().toISOString(), durationMs, id);
    this.deps.bus?.emit({ ...activity, type: 'stop', status: reason ? 'failed' : 'succeeded', usage: { totalTokens: tokens }, durationMs, error: reason || undefined });
    const details = { childRunId: id, role, model: modelKey, tokens, durationMs, status, report };
    return { content: [{ type: 'text' as const, text: `${report}\n\n${JSON.stringify({ childRunId: id, role, model: modelKey, tokens, durationMs, status })}` }], details, ...(reason ? { isError: true } : {}) };
  }
}
