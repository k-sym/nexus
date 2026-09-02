import 'fastify';
import Database from 'better-sqlite3';
import type { PiRuntime } from './pi/runtime.js';
import type { ConcurrencyTracker } from './pi/concurrency.js';
import type { ModelCurationStore } from './pi/model-curation.js';
import type { OAuthFlowManager } from './pi/oauth-flows.js';
import type { ActivityManager } from './activity/manager.js';
import type { DbApprovalAudit } from './approvals/audit.js';
import type { ApnsSender } from './apns/sender.js';
import type { AgentBridgeService } from './agent-bridge/service.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
    pi: PiRuntime;
    chatConcurrency: ConcurrencyTracker;
    modelCuration: ModelCurationStore;
    oauthFlows: OAuthFlowManager;
    activity: ActivityManager;
    approvalAudit?: DbApprovalAudit;
    apns: ApnsSender;
    agentBridge: AgentBridgeService;
    activeChatStreams?: Map<string, { session: { abort: () => Promise<void> } }>;
  }
}

export {};
