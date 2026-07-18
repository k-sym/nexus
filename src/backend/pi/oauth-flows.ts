import { randomUUID } from 'node:crypto';
import {
  type AuthInteraction,
  type AuthPrompt,
} from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

type LoginFn = ModelRuntime['login'];

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
  prompt?: AuthPrompt;
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

  constructor(private readonly auth: Pick<ModelRuntime, 'login'> | { login: LoginFn }) {}

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
      .login(provider, 'oauth', callbacks)
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

  private callbacksFor(flow: FlowRecord): AuthInteraction {
    const waitForInput = (prompt: AuthPrompt) =>
      new Promise<string>((resolve, reject) => {
        flow.state = 'needs_input';
        flow.prompt = prompt;
        flow.waiter = { resolve, reject };
      });

    return {
      signal: flow.controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === 'select' && flow.provider === 'openai-codex') {
          return prompt.options.find((option) => option.id === 'device_code')?.id ?? prompt.options[0]?.id ?? '';
        }
        return waitForInput(prompt);
      },
      notify: (event) => {
        if (event.type === 'auth_url') {
          flow.authUrl = event.url;
          flow.instructions = event.instructions;
        } else if (event.type === 'device_code') {
          flow.deviceCode = event;
          flow.authUrl = event.verificationUri;
          flow.instructions = `Enter code ${event.userCode}`;
        } else if (event.type === 'info' || event.type === 'progress') {
          flow.messages.push(event.message);
        }
      },
    };
  }
}
