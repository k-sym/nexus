import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnginesSection } from './EnginesSection';

function jsonResponse(data: unknown) {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function baseEngine(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'claude-code',
    enabled: true,
    auth: 'subscription',
    tokenConfigured: true,
    authSource: 'token',
    executablePath: '/usr/local/bin/claude',
    modelCount: 3,
    settingSources: [],
    skills: 'all',
    ...overrides,
  };
}

describe('EnginesSection', () => {
  it('renders the Claude Code engine as enabled', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({ engines: [baseEngine()], piAnthropicOAuthHidden: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText(/Enabled/)).toBeInTheDocument();
  });

  it('shows the token authSource explanation', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({ engines: [baseEngine({ authSource: 'token' })], piAnthropicOAuthHidden: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(
      await screen.findByText(/CLAUDE_CODE_OAUTH_TOKEN is set in the backend environment/),
    ).toBeInTheDocument();
  });

  it('shows the login authSource explanation', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({ engines: [baseEngine({ authSource: 'login' })], piAnthropicOAuthHidden: false });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(await screen.findByText(/Using this machine's claude login/)).toBeInTheDocument();
  });

  it('shows the api_key authSource explanation', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({
          engines: [baseEngine({ authSource: 'api_key', auth: 'api_key' })],
          piAnthropicOAuthHidden: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(await screen.findByText(/API key mode/)).toBeInTheDocument();
  });

  it('shows a hand-over notice when Pi Anthropic OAuth is hidden', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({ engines: [baseEngine()], piAnthropicOAuthHidden: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(
      await screen.findByText(/Anthropic subscription models via Pi are hidden while this engine is on/),
    ).toBeInTheDocument();
  });

  it('shows isolated settings and no skills for an empty configuration', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({
          engines: [baseEngine({ settingSources: [], skills: 'none' })],
          piAnthropicOAuthHidden: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(await screen.findByText('Settings loaded: none (isolated)')).toBeInTheDocument();
    expect(await screen.findByText('Skills: none (bundled skills disabled)')).toBeInTheDocument();
  });

  it('shows loaded setting sources and a skill count for a list', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/engines') {
        return jsonResponse({
          engines: [baseEngine({ settingSources: ['user', 'project'], skills: ['pdf', 'docx', 'xlsx'] })],
          piAnthropicOAuthHidden: false,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<EnginesSection />);

    expect(await screen.findByText('Settings loaded: user, project')).toBeInTheDocument();
    expect(await screen.findByText('Skills: 3 listed')).toBeInTheDocument();
  });

  it('degrades to a one-line error when the request fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    });

    render(<EnginesSection />);

    expect(await screen.findByText(/Engine status unavailable/)).toBeInTheDocument();
  });
});
