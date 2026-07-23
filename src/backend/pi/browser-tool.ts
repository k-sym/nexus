/**
 * `browser_navigate` / `browser_read` / `browser_diagnostics`.
 *
 * Phase 1 of #265: enough to load a page, see what is on it, and read what the
 * console and network said — so front-end work can be *verified* in a Nexus
 * thread instead of shipped blind. Interaction (clicking, typing) is Phase 2.
 *
 * The browser is lazy: no session pays for a browser process until it actually
 * navigates somewhere. It is then reused across calls in that thread, because
 * "read the page I just loaded" is the whole point, and torn down with the
 * session.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { checkUrl } from '../browser/policy.js';
import { DEFAULT_DIAGNOSTIC_LIMIT, MAX_DIAGNOSTIC_ENTRIES, type BrowserPage } from '../browser/page.js';

export interface BrowserToolDeps {
  /** Resolve this thread's page, launching the browser on first use. */
  getPage: () => Promise<BrowserPage>;
  /** Hosts beyond loopback this project may reach. */
  allowedHosts: () => string[];
}

const NavigateSchema = Type.Object({
  url: Type.String({ description: 'Absolute http(s) URL, e.g. http://localhost:5173/' }),
});

const ReadSchema = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('tree')], {
    description:
      'text: rendered page text (default). tree: the accessibility tree, roles and names — '
      + 'better for understanding layout and what is interactive.',
  })),
  selector: Type.Optional(Type.String({
    description: 'CSS selector to scope a text read to. Ignored for tree reads.',
  })),
});

const DiagnosticsSchema = Type.Object({
  source: Type.Union([Type.Literal('console'), Type.Literal('network')], {
    description: 'console: page console and error output. network: requests and their status codes.',
  }),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_DIAGNOSTIC_ENTRIES,
    description: `Most recent entries to return (default ${DEFAULT_DIAGNOSTIC_LIMIT}).`,
  })),
});

export interface BrowserToolNames {
  navigate: 'browser_navigate';
  read: 'browser_read';
  diagnostics: 'browser_diagnostics';
}

export function createBrowserExtension(deps: BrowserToolDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'browser_navigate',
      label: 'Open a page',
      description:
        'Load a URL in a headless browser and report where it landed. Use it to see a running dev '
        + 'server or reproduce a bug that only happens in a browser. Limited to this machine '
        + '(localhost) unless the project has allowed other hosts. Follow it with browser_read to '
        + 'see the page and browser_diagnostics for console or network output.',
      promptSnippet: 'browser_navigate: load a URL in a headless browser',
      parameters: NavigateSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; url: string; httpStatus?: number }>> {
        // Pi turns a throw into an error tool result and continues the turn, so
        // throw rather than returning a pseudo-error for the model to parse.
        const verdict = checkUrl(params.url, deps.allowedHosts());
        if (!verdict.allowed) throw new Error(verdict.reason);

        const page = await deps.getPage();
        const result = await page.navigate(verdict.url);
        const statusLine = result.status ? ` (HTTP ${result.status})` : '';
        return {
          content: [{
            type: 'text',
            text: `Loaded ${result.url}${statusLine}${result.title ? `\nTitle: ${result.title}` : ''}`,
          }],
          details: { status: 'ok', url: result.url, httpStatus: result.status },
        };
      },
    });

    pi.registerTool({
      name: 'browser_read',
      label: 'Read the page',
      description:
        'Read the currently loaded page: its rendered text, or its accessibility tree. Returns text '
        + 'rather than an image, so it is cheap enough to call freely. Use the tree mode to find out '
        + 'what is on the page and what is interactive; use a selector to read one region.',
      promptSnippet: 'browser_read: read the loaded page as text or an accessibility tree',
      parameters: ReadSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; mode: string }>> {
        const page = await deps.getPage();
        const mode = params.mode ?? 'text';
        const text = mode === 'tree' ? await page.readTree() : await page.readText(params.selector);
        return {
          content: [{ type: 'text', text: text || '(the page is empty)' }],
          details: { status: 'ok', mode },
        };
      },
    });

    pi.registerTool({
      name: 'browser_diagnostics',
      label: 'Page diagnostics',
      description:
        'Read what the page reported while it loaded: console messages and errors, or network '
        + 'requests with their status codes. This is the fastest way to find out why a page looks '
        + 'broken. Entries are captured continuously, so this covers the load you already did.',
      promptSnippet: 'browser_diagnostics: read the page\'s console output or network requests',
      parameters: DiagnosticsSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; source: string; count: number }>> {
        const page = await deps.getPage();
        const limit = params.limit ?? DEFAULT_DIAGNOSTIC_LIMIT;

        if (params.source === 'console') {
          const entries = page.consoleEntries(limit);
          return {
            content: [{
              type: 'text',
              text: entries.length === 0
                ? 'The page logged nothing.'
                : entries.map((e) => `[${e.level}] ${e.text}${e.url ? ` (${e.url})` : ''}`).join('\n'),
            }],
            details: { status: 'ok', source: 'console', count: entries.length },
          };
        }

        const entries = page.networkEntries(limit);
        return {
          content: [{
            type: 'text',
            text: entries.length === 0
              ? 'No network requests were recorded.'
              : entries.map((e) => `${e.method} ${e.url} — ${e.failed ? `FAILED: ${e.failed}` : e.status ?? '?'}`).join('\n'),
          }],
          details: { status: 'ok', source: 'network', count: entries.length },
        };
      },
    });
  };
}
