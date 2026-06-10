import { randomUUID } from 'node:crypto';
import type { AuthStorage } from '@earendil-works/pi-coding-agent';
import {
  OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
  type OAuthLoginCallbacks,
  type OAuthPrompt,
  type OAuthSelectPrompt,
} from '@earendil-works/pi-ai/oauth';

type LoginFn = AuthStorage['login'];

export type OAuthFlowState = 'pending' | 'needs_input' | 'complete' | 'error' | 'cancelled';

export interface OAuthFlowStatus {
  id: string;
  provider: string;
  state: OAuthFlowState;
  authUrl?: string;
  instructions?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  prompt?: OAuthPrompt;
  messages: string[];
  error?: string;
}

interface PromptWaiter {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface FlowRecord extends OAuthFlowStatus {
  controller: AbortController;
  waiter?: PromptWaiter;
  done: Promise<void>;
}

export class OAuthFlowManager {
  private readonly flows = new Map<string, FlowRecord>();

  constructor(private readonly auth: Pick<AuthStorage, 'login'> | { login: LoginFn }) {}

  start(provider: string): { id: string; done: Promise<void> } {
    const id = randomUUID();
    const controller = new AbortController();
    const record: FlowRecord = {
      id,
      provider,
      state: 'pending',
      messages: [],
      controller,
      done: Promise.resolve(),
    };
    const callbacks = this.callbacksFor(record);
    record.done = this.auth
      .login(provider as never, callbacks)
      .then(() => {
        if (record.state !== 'cancelled') {
          record.state = 'complete';
          record.prompt = undefined;
          record.waiter = undefined;
        }
      })
      .catch((err: unknown) => {
        if (record.state === 'cancelled') return;
        record.state = 'error';
        record.error = err instanceof Error ? err.message : String(err);
        record.waiter = undefined;
      });
    this.flows.set(id, record);
    return { id, done: record.done };
  }

  status(id: string): OAuthFlowStatus | undefined {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    const { controller: _controller, waiter: _waiter, done: _done, ...status } = flow;
    return status;
  }

  respond(id: string, value: string): boolean {
    const flow = this.flows.get(id);
    if (!flow?.waiter) return false;
    const waiter = flow.waiter;
    flow.waiter = undefined;
    flow.prompt = undefined;
    flow.state = 'pending';
    waiter.resolve(value);
    return true;
  }

  cancel(id: string): boolean {
    const flow = this.flows.get(id);
    if (!flow || flow.state === 'complete' || flow.state === 'cancelled') return false;
    flow.state = 'cancelled';
    flow.error = undefined;
    flow.waiter?.reject(new Error('Login cancelled'));
    flow.waiter = undefined;
    flow.controller.abort();
    return true;
  }

  private callbacksFor(flow: FlowRecord): OAuthLoginCallbacks {
    const waitForInput = (prompt: OAuthPrompt) =>
      new Promise<string>((resolve, reject) => {
        flow.state = 'needs_input';
        flow.prompt = prompt;
        flow.waiter = { resolve, reject };
      });

    return {
      signal: flow.controller.signal,
      onAuth: (info) => {
        flow.authUrl = info.url;
        flow.instructions = info.instructions;
      },
      onDeviceCode: (info) => {
        flow.deviceCode = info;
        flow.authUrl = info.verificationUri;
        flow.instructions = `Enter code ${info.userCode}`;
      },
      onPrompt: waitForInput,
      onManualCodeInput: () =>
        waitForInput({
          message: 'Paste the final OAuth redirect URL or authorization code.',
          placeholder: 'https://.../callback?code=...',
        }),
      onProgress: (message) => {
        flow.messages.push(message);
      },
      onSelect: async (prompt: OAuthSelectPrompt) => {
        if (flow.provider === 'openai-codex') return OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD;
        return prompt.options[0]?.id;
      },
    };
  }
}
