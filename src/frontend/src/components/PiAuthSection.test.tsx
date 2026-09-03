import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAuthSection } from './PiAuthSection';

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PiAuthSection', () => {
  it('shows Amazon Bedrock in the provider auth list', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PiAuthSection />);

    expect(await screen.findByText('Amazon Bedrock')).toBeInTheDocument();
  });

  it('starts OpenAI Codex subscription OAuth and shows device-code guidance', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [] });
      }
      if (url === '/api/auth/start-oauth') {
        return jsonResponse({ ok: true, flowId: 'flow-1' });
      }
      if (url === '/api/auth/oauth/flow-1') {
        return jsonResponse({
          id: 'flow-1',
          provider: 'openai-codex',
          state: 'pending',
          deviceCode: {
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://microsoft.com/devicelogin',
          },
          instructions: 'Enter this code in your browser.',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PiAuthSection />);
    await screen.findByText('OpenAI Codex');

    await userEvent.click(screen.getByRole('button', { name: /Subscription login OpenAI Codex/i }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByText(/Enter this code in your browser/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open login page/i })).toHaveAttribute(
      'href',
      'https://microsoft.com/devicelogin',
    );
  });

  it('submits manual subscription OAuth input for Anthropic', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [] });
      }
      if (url === '/api/auth/start-oauth') {
        return jsonResponse({ ok: true, flowId: 'flow-2' });
      }
      if (url === '/api/auth/oauth/flow-2') {
        return jsonResponse({
          id: 'flow-2',
          provider: 'anthropic',
          state: 'needs_input',
          prompt: { message: 'Paste OAuth code' },
          messages: ['Waiting for authorization code.'],
        });
      }
      if (url === '/api/auth/oauth/flow-2/respond') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PiAuthSection />);
    await screen.findByText('Anthropic (Claude)');

    await userEvent.click(screen.getByRole('button', { name: /Subscription login Anthropic/i }));
    await userEvent.type(await screen.findByLabelText(/Paste OAuth code/i), 'oauth-code');
    await userEvent.click(screen.getByRole('button', { name: /Submit OAuth response/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/oauth/flow-2/respond',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ value: 'oauth-code' }),
        }),
      ),
    );
  });

  it('notifies model selectors when OAuth completes', async () => {
    const listener = vi.fn();
    window.addEventListener('nexus:models-refresh', listener);
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [] });
      }
      if (url === '/api/auth/start-oauth') {
        return jsonResponse({ ok: true, flowId: 'flow-3' });
      }
      if (url === '/api/auth/oauth/flow-3') {
        return jsonResponse({
          id: 'flow-3',
          provider: 'openai-codex',
          state: 'complete',
          messages: ['Logged in.'],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      render(<PiAuthSection />);
      await screen.findByText('OpenAI Codex');

      await userEvent.click(screen.getByRole('button', { name: /Subscription login OpenAI Codex/i }));

      await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener('nexus:models-refresh', listener);
    }
  });

  it('hands Anthropic over to the Claude Code engine when it is enabled', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [{ id: 'anthropic', type: 'oauth' }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PiAuthSection claudeEngineEnabled />);
    await screen.findByText('Anthropic (Claude)');

    expect(screen.getByText('Handled by the Claude Code engine')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Subscription login Anthropic/i }),
    ).not.toBeInTheDocument();
  });

  it('still allows an Anthropic API key when the Claude Code engine owns subscription login', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [] });
      }
      if (url === '/api/auth/save-key') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PiAuthSection claudeEngineEnabled />);
    await screen.findByText('Anthropic (Claude)');

    expect(screen.getByText('Handled by the Claude Code engine')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Subscription login Anthropic/i }),
    ).not.toBeInTheDocument();

    const anthropicRow = screen.getByText('Anthropic (Claude)').closest('div') as HTMLElement;
    const input = within(anthropicRow).getByPlaceholderText('sk-…');

    await userEvent.type(input, 'sk-ant-test');
    await userEvent.click(within(anthropicRow).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/save-key',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ provider: 'anthropic', key: 'sk-ant-test' }),
        }),
      ),
    );
  });

  it('keeps the normal Anthropic subscription login when the Claude Code engine is not enabled', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/status') {
        return jsonResponse({ providers: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PiAuthSection />);
    await screen.findByText('Anthropic (Claude)');

    expect(screen.getByRole('button', { name: /Subscription login Anthropic/i })).toBeInTheDocument();
    expect(screen.queryByText('Handled by the Claude Code engine')).not.toBeInTheDocument();
  });
});
