import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZosmaAuthSection } from './ZosmaAuthSection';

const noProviders = { providers: [], hasAny: false };
const anthropicKey = { providers: [{ id: 'anthropic', type: 'api_key' as const }], hasAny: true };

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => noProviders });
});

describe('ZosmaAuthSection', () => {
  it('renders the section title', async () => {
    render(<ZosmaAuthSection />);
    expect(screen.getByText(/Zosma sign-in/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId(/^auth-row-/).length).toBeGreaterThan(0));
  });

  it('marks Anthropic as "Not configured" when no creds are set', async () => {
    render(<ZosmaAuthSection />);
    await waitFor(() => {
      const row = screen.getByTestId('auth-row-anthropic');
      expect(row).toHaveTextContent(/Not configured/i);
    });
  });

  it('reflects the API key state from the backend', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => anthropicKey });
    render(<ZosmaAuthSection />);
    await waitFor(() => {
      const row = screen.getByTestId('auth-row-anthropic');
      expect(row).toHaveTextContent(/API key saved/i);
    });
  });

  it('submits a new API key on Save', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/status') {
        return { ok: true, json: async () => noProviders };
      }
      if (url === '/api/auth/save-key') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(init?.body as string);
        expect(body.provider).toBe('anthropic');
        expect(body.key).toBe('sk-test-12345');
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error('unexpected: ' + url);
    });
    global.fetch = fetchMock;
    render(<ZosmaAuthSection />);
    await waitFor(() => expect(screen.getByTestId('auth-form-anthropic')).toBeInTheDocument());
    const input = screen.getByTestId('auth-form-anthropic').querySelector('input')!;
    await userEvent.type(input, 'sk-test-12345');
    await userEvent.click(screen.getByTestId('auth-form-anthropic').querySelector('button')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/save-key', expect.any(Object)));
  });
});
