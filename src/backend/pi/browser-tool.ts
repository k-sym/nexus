/**
 * The browser tool surface: navigate, read, diagnostics (Phase 1), plus act and
 * screenshot (Phase 2, #265).
 *
 * Together these let a session verify front-end work in a Nexus thread instead
 * of shipping it blind: load a page, see what's on it, interact with it, read
 * what the console and network said, and — for a vision model — look at it.
 *
 * The browser is lazy: no session pays for a browser process until it actually
 * navigates somewhere. It is then reused across calls in that thread, because
 * "read the page I just loaded, then click the button on it" is the whole
 * point, and torn down with the session.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { checkUrl } from '../browser/policy.js';
import { SUPPORTED_KEYS } from '../browser/input.js';
import {
  DEFAULT_DIAGNOSTIC_LIMIT, MAX_DIAGNOSTIC_ENTRIES,
  MIN_VIEWPORT_DIMENSION, MAX_VIEWPORT_DIMENSION, SUPPORTED_COLOR_SCHEMES,
  type BrowserPage,
} from '../browser/page.js';

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

const ActSchema = Type.Object({
  action: Type.Union([
    Type.Literal('click'),
    Type.Literal('type'),
    Type.Literal('press'),
    Type.Literal('scroll'),
  ], {
    description:
      'click: click an element by ref. type: focus an element by ref and type text. '
      + 'press: press a named key (optionally focusing a ref first). scroll: scroll the page.',
  }),
  ref: Type.Optional(Type.String({
    description: 'Element ref from a browser_read tree call (e.g. "ref_3"). Required for click/type.',
  })),
  text: Type.Optional(Type.String({ description: 'Text to type (type action).' })),
  key: Type.Optional(Type.String({ description: `Key to press (press action). One of: ${SUPPORTED_KEYS.join(', ')}.` })),
  direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')], {
    description: 'Scroll direction (scroll action; default down).',
  })),
});

const ScreenshotSchema = Type.Object({
  ref: Type.Optional(Type.String({ description: 'Clip to one element by ref (from a browser_read tree call).' })),
  full_page: Type.Optional(Type.Boolean({ description: 'Capture the whole page, not just the viewport.' })),
});

const EmulateSchema = Type.Object({
  width: Type.Optional(Type.Integer({
    minimum: MIN_VIEWPORT_DIMENSION, maximum: MAX_VIEWPORT_DIMENSION,
    description: 'Viewport width in CSS pixels. Set width and height together.',
  })),
  height: Type.Optional(Type.Integer({
    minimum: MIN_VIEWPORT_DIMENSION, maximum: MAX_VIEWPORT_DIMENSION,
    description: 'Viewport height in CSS pixels. Set width and height together.',
  })),
  color_scheme: Type.Optional(Type.Union(
    SUPPORTED_COLOR_SCHEMES.map((s) => Type.Literal(s)),
    { description: 'Emulate prefers-color-scheme for a theme check: light, dark, or no-preference.' },
  )),
  reset: Type.Optional(Type.Boolean({
    description: 'Clear all emulation (viewport and color-scheme) back to the browser defaults.',
  })),
});

export interface BrowserToolNames {
  navigate: 'browser_navigate';
  read: 'browser_read';
  diagnostics: 'browser_diagnostics';
  act: 'browser_act';
  screenshot: 'browser_screenshot';
  emulate: 'browser_emulate';
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

    pi.registerTool({
      name: 'browser_act',
      label: 'Interact with the page',
      description:
        'Interact with the loaded page: click an element, type into it, press a key, or scroll. '
        + 'Click and type target an element by its ref — call browser_read with mode "tree" first to '
        + 'see the page and get refs (they look like "ref_3"). Refs expire on the next read or a '
        + 'navigation, so read again if a ref is rejected. Read the page again after acting to see what changed.',
      promptSnippet: 'browser_act: click, type, press a key, or scroll the loaded page',
      parameters: ActSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; action: string }>> {
        const page = await deps.getPage();
        const done = (text: string) => ({
          content: [{ type: 'text' as const, text }],
          details: { status: 'ok', action: params.action },
        });

        switch (params.action) {
          case 'click': {
            if (!params.ref) throw new Error('click needs a ref (from a browser_read tree call).');
            return done(await page.clickRef(params.ref));
          }
          case 'type': {
            if (!params.ref) throw new Error('type needs a ref (from a browser_read tree call).');
            if (params.text === undefined) throw new Error('type needs text.');
            return done(await page.typeIntoRef(params.ref, params.text));
          }
          case 'press': {
            if (!params.key) throw new Error('press needs a key.');
            return done(await page.pressKey(params.key, params.ref));
          }
          case 'scroll':
            return done(await page.scrollPage(params.direction ?? 'down'));
        }
      },
    });

    pi.registerTool({
      name: 'browser_screenshot',
      label: 'Screenshot the page',
      description:
        'Capture a PNG of the loaded page — the viewport by default, one element with a ref, or the '
        + 'whole page with full_page. Returns an image, so it is only useful to you if you can see '
        + 'images; prefer browser_read for anything text can answer, and reach for a screenshot when '
        + 'the visual layout itself is the question.',
      promptSnippet: 'browser_screenshot: capture a PNG of the loaded page (viewport, an element, or full page)',
      parameters: ScreenshotSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; scope: string }>> {
        const page = await deps.getPage();
        const shot = await page.screenshot({ ref: params.ref, fullPage: params.full_page });
        const scope = params.ref ? `element ${params.ref}` : params.full_page ? 'full page' : 'viewport';
        return {
          content: [
            { type: 'image', data: shot.data, mimeType: shot.mimeType },
            { type: 'text', text: `Screenshot (${scope}).` },
          ],
          details: { status: 'ok', scope },
        };
      },
    });

    pi.registerTool({
      name: 'browser_emulate',
      label: 'Emulate viewport / theme',
      description:
        'Set the browser\'s viewport size and/or emulated color scheme, for responsive and dark-mode '
        + 'checks. Give width and height together to resize the viewport (CSS pixels); set color_scheme '
        + 'to light, dark, or no-preference to override prefers-color-scheme. Overrides persist across '
        + 'navigations until you change them or pass reset:true. Follow with browser_read or '
        + 'browser_screenshot to see the page at the new size or theme.',
      promptSnippet: 'browser_emulate: set the viewport size or emulated color scheme (responsive/theme checks)',
      parameters: EmulateSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; applied: string[] }>> {
        const hasWidth = params.width !== undefined;
        const hasHeight = params.height !== undefined;
        if (hasWidth !== hasHeight) throw new Error('Set width and height together to resize the viewport.');
        if (!params.reset && !hasWidth && params.color_scheme === undefined) {
          throw new Error('Nothing to emulate — pass width+height, color_scheme, or reset:true.');
        }

        const page = await deps.getPage();
        const applied: string[] = [];

        // reset first, so `reset:true` with a new viewport/scheme means "clear,
        // then apply these" rather than clearing what was just set.
        if (params.reset) applied.push(await page.resetEmulation());
        if (hasWidth) applied.push(await page.setViewport(params.width!, params.height!));
        if (params.color_scheme !== undefined) applied.push(await page.setColorScheme(params.color_scheme));

        return {
          content: [{ type: 'text', text: applied.join(' ') }],
          details: { status: 'ok', applied },
        };
      },
    });
  };
}
