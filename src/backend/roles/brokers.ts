import type { RoleName } from '@nexus/shared';
import type { ApprovalBroker } from '../pi/approvals.js';
import type { QuestionBroker } from '../pi/questions.js';
export function labelledApprovals(broker: ApprovalBroker, role: RoleName, linkage?: { childRunId: string; parentToolCallId?: string }): ApprovalBroker {
  const label = role[0].toUpperCase() + role.slice(1);
  return new Proxy(broker, { get(target, key) {
    if (key === 'register') return (...args: Parameters<ApprovalBroker['register']>) => {
      const [thread, call, tool, input, cwd, signal, timeout] = args;
      return target.register(thread, call, `${label} · ${tool}`, input, cwd, signal, timeout, linkage);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export function labelledQuestions(broker: QuestionBroker, role: RoleName): QuestionBroker {
  const label = role[0].toUpperCase() + role.slice(1);
  return new Proxy(broker, { get(target, key) {
    if (key === 'register') return (...args: Parameters<QuestionBroker['register']>) => {
      const [thread, call, request, signal] = args;
      return target.register(thread, call, { ...request, questions: request.questions.map(q => ({ ...q, header: `${label} · ${q.header}` })) }, signal);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
