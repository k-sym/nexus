/**
 * A single page, driven over CDP.
 *
 * The read path is deliberately text-first. A raw DOM dump or a screenshot per
 * step exhausts a context window in a handful of turns, which was flagged in
 * #265 as the real risk of this feature — bigger than the driving itself. So
 * the defaults are `text` (rendered innerText) and `tree` (the accessibility
 * tree, roles and names only), both bounded, and everything returned here also
 * passes through the existing signal-filter projection on its way to the model.
 *
 * Console and network output are captured continuously into ring buffers rather
 * than fetched on demand, because the interesting entries are the ones emitted
 * *during* navigation — by the time the model thinks to ask, they are gone.
 *
 * Part of #265.
 */
import { boundTailText } from '../text/bound.js';
import { isInteractiveRole, keyDefinition, quadCenter, SUPPORTED_KEYS } from './input.js';
import type { CdpConnection } from './cdp.js';

/** Cap on any single read handed back to the model. */
export const MAX_READ_BYTES = 32 * 1024;
/** Entries kept per diagnostic stream. Oldest are dropped. */
export const MAX_DIAGNOSTIC_ENTRIES = 200;
/** Default entries returned by a diagnostics call. */
export const DEFAULT_DIAGNOSTIC_LIMIT = 50;
/** How long to wait for a navigation to reach its load event. */
export const NAVIGATION_TIMEOUT_MS = 30_000;
/** Cap on a full-page screenshot's height, so a very long page can't produce an
 *  enormous image. Screenshots skip the text projection, so this is the bound. */
export const MAX_SCREENSHOT_HEIGHT = 4_000;

/** Marks "querySelector found nothing" in an evaluated expression's result. */
const MISSING_SENTINEL = '__nexus_no_such_element__';

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  failed?: string;
}

export interface NavigationResult {
  url: string;
  title: string;
  status?: number;
}

/** Push onto a ring buffer, dropping the oldest when full. */
function push<T>(buffer: T[], entry: T, max: number): void {
  buffer.push(entry);
  if (buffer.length > max) buffer.splice(0, buffer.length - max);
}

function textOfConsoleArgs(args: unknown): string {
  if (!Array.isArray(args)) return '';
  return args
    .map((arg) => {
      const a = arg as { value?: unknown; description?: unknown; type?: unknown };
      if (a?.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      if (a?.description !== undefined) return String(a.description);
      return String(a?.type ?? '');
    })
    .join(' ')
    .trim();
}

export class BrowserPage {
  private readonly console: ConsoleEntry[] = [];
  private readonly network: NetworkEntry[] = [];
  private readonly requestMethods = new Map<string, { method: string; url: string }>();
  private lastMainFrameStatus?: number;
  private mainFrameId?: string;
  /** ref id → CDP backendDOMNodeId, populated by a tree read and consumed by
   *  `act`. Cleared on navigation: a ref points at a node in the page that was
   *  loaded when it was read, and after navigating that node is gone. */
  private refs = new Map<string, number>();

  private constructor(
    private readonly connection: CdpConnection,
    private readonly sessionId: string,
  ) {}

  /** Open a fresh tab and start listening. */
  static async create(connection: CdpConnection): Promise<BrowserPage> {
    const created = await connection.send('Target.createTarget', { url: 'about:blank' });
    const targetId = String(created.targetId);
    const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);

    const page = new BrowserPage(connection, sessionId);
    connection.on((event) => page.onEvent(event.method, event.params, event.sessionId));

    // DOM is enabled for interaction (focus/box-model/scroll by backend node id).
    // Accessibility is enabled lazily on the first tree read. CSS stays off — a
    // firehose we have no use for.
    for (const domain of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.enable']) {
      await connection.send(domain, {}, sessionId);
    }
    return page;
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (sessionId && sessionId !== this.sessionId) return;

    switch (method) {
      case 'Runtime.consoleAPICalled':
        push(this.console, {
          level: String(params.type ?? 'log'),
          text: textOfConsoleArgs(params.args),
        }, MAX_DIAGNOSTIC_ENTRIES);
        return;

      case 'Log.entryAdded': {
        const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
        if (!entry) return;
        // This is where page errors and failed subresource loads surface —
        // the entries a developer actually wants after "it looks broken".
        push(this.console, {
          level: String(entry.level ?? 'info'),
          text: String(entry.text ?? ''),
          ...(entry.url ? { url: entry.url } : {}),
        }, MAX_DIAGNOSTIC_ENTRIES);
        return;
      }

      case 'Network.requestWillBeSent': {
        const request = params.request as { method?: string; url?: string } | undefined;
        const id = String(params.requestId ?? '');
        if (!id || !request?.url) return;
        this.requestMethods.set(id, { method: String(request.method ?? 'GET'), url: String(request.url) });
        return;
      }

      case 'Network.responseReceived': {
        const id = String(params.requestId ?? '');
        const response = params.response as { status?: number; url?: string } | undefined;
        const pending = this.requestMethods.get(id);
        this.requestMethods.delete(id);
        if (!response) return;
        const status = typeof response.status === 'number' ? response.status : undefined;
        push(this.network, {
          method: pending?.method ?? 'GET',
          url: String(response.url ?? pending?.url ?? ''),
          status,
        }, MAX_DIAGNOSTIC_ENTRIES);
        // The document response for the main frame is the page's own status —
        // a 404 that still renders HTML is exactly what someone is checking for.
        if (params.type === 'Document' && (!this.mainFrameId || params.frameId === this.mainFrameId)) {
          this.lastMainFrameStatus = status;
        }
        return;
      }

      case 'Network.loadingFailed': {
        const id = String(params.requestId ?? '');
        const pending = this.requestMethods.get(id);
        this.requestMethods.delete(id);
        push(this.network, {
          method: pending?.method ?? 'GET',
          url: pending?.url ?? '',
          failed: String(params.errorText ?? 'failed'),
        }, MAX_DIAGNOSTIC_ENTRIES);
        return;
      }

      default:
    }
  }

  /**
   * Load `url` and wait for its load event.
   *
   * `Page.navigate` resolving means the navigation *started*; the page is not
   * readable until `Page.loadEventFired`. Waiting is subscribed before the
   * command is sent, or a fast local page can fire the event first and leave us
   * waiting for one that has already happened.
   */
  async navigate(url: string, timeoutMs = NAVIGATION_TIMEOUT_MS): Promise<NavigationResult> {
    this.lastMainFrameStatus = undefined;
    // Refs belong to the page being left; the model must re-read to act on the
    // new one.
    this.refs.clear();

    const loaded = this.waitForEvent('Page.loadEventFired', timeoutMs);
    let result: Record<string, unknown>;
    try {
      result = await this.connection.send('Page.navigate', { url }, this.sessionId);
    } catch (error) {
      loaded.cancel();
      throw error;
    }

    if (typeof result.errorText === 'string' && result.errorText) {
      loaded.cancel();
      // Net-level failures (DNS, connection refused) never reach a load event,
      // so this must be surfaced rather than waited out.
      throw new Error(`Could not load ${url}: ${result.errorText}`);
    }
    if (typeof result.frameId === 'string') this.mainFrameId = result.frameId;

    try {
      await loaded.promise;
    } catch {
      // A page that never fires `load` (a hung subresource, a streaming
      // response) is still worth reading — report what is there rather than
      // failing the whole call.
    }

    const [currentUrl, title] = await Promise.all([
      this.evaluateString('location.href'),
      this.evaluateString('document.title'),
    ]);
    return { url: currentUrl || url, title, status: this.lastMainFrameStatus };
  }

  /** Rendered text, optionally scoped to a selector. */
  async readText(selector?: string): Promise<string> {
    const target = selector
      ? `document.querySelector(${JSON.stringify(selector)})`
      : 'document.body';
    // A sentinel rather than an empty string, so "the selector matched nothing"
    // stays distinguishable from "it matched an element with no text".
    const expression = `(() => { const el = ${target}; return el ? (el.innerText || el.textContent || '') `
      + `: ${JSON.stringify(MISSING_SENTINEL)}; })()`;
    const value = await this.evaluateString(expression);
    if (value === MISSING_SENTINEL) throw new Error(`No element matched selector: ${selector}`);
    return boundTailText(value.trim(), MAX_READ_BYTES, '[earlier page content truncated]');
  }

  /**
   * The accessibility tree as indented `role "name"` lines.
   *
   * Roles and names only: it is a fraction of the size of the DOM and closer to
   * what a person perceives, which makes it both cheaper and more useful for
   * "what is on this page".
   *
   * Interactive elements are tagged with a `[ref_N]` handle and their backend
   * node id is recorded, so `act` can click or type into them by ref. Reading
   * the tree is therefore the prerequisite for interacting: the model reads to
   * see what's there and to get the refs, then acts on them. Each read replaces
   * the ref set — a ref is only valid until the next read or a navigation.
   */
  async readTree(): Promise<string> {
    await this.connection.send('Accessibility.enable', {}, this.sessionId);
    const result = await this.connection.send('Accessibility.getFullAXTree', {}, this.sessionId);
    const nodes = Array.isArray(result.nodes) ? result.nodes as Array<Record<string, unknown>> : [];

    const byId = new Map<string, Record<string, unknown>>();
    for (const node of nodes) byId.set(String(node.nodeId), node);

    // An AXNode's `role`/`name` are AXValue: `{ type, value }`, where `value`
    // is the string itself — not a further nested AXValue.
    const valueOf = (field: unknown): string => {
      const v = (field as { value?: unknown } | undefined)?.value;
      return v === undefined || v === null ? '' : String(v);
    };

    this.refs.clear();
    let refCounter = 0;
    const lines: string[] = [];
    const walk = (nodeId: string, depth: number): void => {
      if (depth > 25) return; // pathological nesting
      const node = byId.get(nodeId);
      if (!node) return;
      const ignored = node.ignored === true;
      const role = valueOf(node.role);
      const name = valueOf(node.name);
      if (!ignored && role && role !== 'none' && role !== 'generic') {
        let line = `${'  '.repeat(Math.min(depth, 12))}${role}${name ? ` "${name}"` : ''}`;
        // A ref only where the element is both actionable and addressable: a
        // backend node id is what `act` resolves against.
        const backendId = node.backendDOMNodeId;
        if (isInteractiveRole(role) && typeof backendId === 'number') {
          const ref = `ref_${++refCounter}`;
          this.refs.set(ref, backendId);
          line += ` [${ref}]`;
        }
        lines.push(line);
      }
      const children = Array.isArray(node.childIds) ? node.childIds as string[] : [];
      // Ignored/generic wrappers don't consume a level, so the output isn't a
      // staircase of meaningless indentation.
      const nextDepth = ignored || !role || role === 'none' || role === 'generic' ? depth : depth + 1;
      for (const child of children) walk(String(child), nextDepth);
    };

    if (nodes.length > 0) walk(String(nodes[0].nodeId), 0);
    return boundTailText(lines.join('\n'), MAX_READ_BYTES, '[earlier tree content truncated]');
  }

  /** Resolve a ref to its backend node id, or throw a message that tells the
   *  model how to recover — the common failure is acting on a stale page. */
  private backendNodeFor(ref: string): number {
    const id = this.refs.get(ref.trim());
    if (id === undefined) {
      throw new Error(
        `Unknown or stale ref "${ref}". Refs come from a tree read and expire on the next read or a navigation — `
        + 'call browser_read with mode "tree" to get current refs, then act on those.',
      );
    }
    return id;
  }

  /** Click the element a ref points at, scrolling it into view first. */
  async clickRef(ref: string): Promise<string> {
    const backendNodeId = this.backendNodeFor(ref);
    // Best-effort: an element already in view, or one CDP declines to scroll,
    // is still clickable at whatever coordinates the box model reports.
    await this.connection.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, this.sessionId).catch(() => {});
    const box = await this.connection.send('DOM.getBoxModel', { backendNodeId }, this.sessionId);
    const quad = (box.model as { content?: number[] } | undefined)?.content;
    const center = quadCenter(quad ?? []);
    if (!center) throw new Error(`Element ${ref} has no layout box to click (it may be hidden).`);

    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      await this.connection.send('Input.dispatchMouseEvent', {
        type, x: center.x, y: center.y, button: 'left', clickCount: 1,
      }, this.sessionId);
    }
    return `Clicked ${ref}.`;
  }

  /** Focus the element a ref points at and type `text` into it. */
  async typeIntoRef(ref: string, text: string): Promise<string> {
    const backendNodeId = this.backendNodeFor(ref);
    await this.connection.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, this.sessionId).catch(() => {});
    await this.connection.send('DOM.focus', { backendNodeId }, this.sessionId);
    // insertText fires the real input/change events a framework listens for —
    // unlike setting .value, which many controlled inputs ignore.
    await this.connection.send('Input.insertText', { text }, this.sessionId);
    return `Typed into ${ref}.`;
  }

  /** Press a named key. Focuses `ref` first when given, so "type then Enter"
   *  lands on the right field. */
  async pressKey(key: string, ref?: string): Promise<string> {
    const def = keyDefinition(key);
    if (!def) throw new Error(`Unsupported key "${key}". Supported: ${SUPPORTED_KEYS.join(', ')}.`);
    if (ref) {
      const backendNodeId = this.backendNodeFor(ref);
      await this.connection.send('DOM.focus', { backendNodeId }, this.sessionId).catch(() => {});
    }
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode };
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(def.text ? { text: def.text } : {}) }, this.sessionId);
    await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
    return `Pressed ${def.key}.`;
  }

  /** Scroll the page a screenful in a direction. */
  async scrollPage(direction: 'up' | 'down'): Promise<string> {
    const dy = direction === 'up' ? -600 : 600;
    await this.evaluateString(`(() => { window.scrollBy(0, ${dy}); return ''; })()`);
    return `Scrolled ${direction}.`;
  }

  /**
   * A PNG screenshot, base64-encoded, as image content for a vision model.
   *
   * Defaults to the viewport. `ref` clips to one element; `fullPage` captures
   * beyond the viewport, capped so a very long page can't produce an enormous
   * image (screenshots skip the signal-filter text projection — they are the
   * one unbounded thing the browser can return, so the cap lives here).
   */
  async screenshot(options: { ref?: string; fullPage?: boolean } = {}): Promise<{ data: string; mimeType: string }> {
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let captureBeyondViewport = false;

    if (options.ref) {
      const backendNodeId = this.backendNodeFor(options.ref);
      await this.connection.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, this.sessionId).catch(() => {});
      const box = await this.connection.send('DOM.getBoxModel', { backendNodeId }, this.sessionId);
      const quad = (box.model as { content?: number[] } | undefined)?.content ?? [];
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      if (xs.some((n) => n === undefined)) throw new Error(`Element ${options.ref} has no layout box to capture.`);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      clip = { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y), scale: 1 };
    } else if (options.fullPage) {
      const metrics = await this.connection.send('Page.getLayoutMetrics', {}, this.sessionId);
      const size = (metrics.cssContentSize ?? metrics.contentSize) as { width?: number; height?: number } | undefined;
      captureBeyondViewport = true;
      clip = {
        x: 0, y: 0,
        width: Math.max(1, Math.round(size?.width ?? 1280)),
        height: Math.min(MAX_SCREENSHOT_HEIGHT, Math.max(1, Math.round(size?.height ?? 720))),
        scale: 1,
      };
    }

    const result = await this.connection.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {}),
      ...(captureBeyondViewport ? { captureBeyondViewport: true } : {}),
    }, this.sessionId);
    return { data: String(result.data ?? ''), mimeType: 'image/png' };
  }

  consoleEntries(limit = DEFAULT_DIAGNOSTIC_LIMIT): ConsoleEntry[] {
    return this.console.slice(-Math.max(1, limit));
  }

  networkEntries(limit = DEFAULT_DIAGNOSTIC_LIMIT): NetworkEntry[] {
    return this.network.slice(-Math.max(1, limit));
  }

  private async evaluateString(expression: string): Promise<string> {
    const result = await this.connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: false },
      this.sessionId,
    );
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) throw new Error(`Page evaluation failed: ${exception.text ?? 'unknown error'}`);
    const value = (result.result as { value?: unknown } | undefined)?.value;
    return value === undefined || value === null ? '' : String(value);
  }

  /** Resolve on the next matching event, with a timeout and a cancel handle. */
  private waitForEvent(method: string, timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle: (() => void) | undefined;

    const promise = new Promise<void>((resolve, reject) => {
      settle = resolve;
      unsubscribe = this.connection.on((event) => {
        if (event.method !== method) return;
        if (event.sessionId && event.sessionId !== this.sessionId) return;
        cleanup();
        resolve();
      });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      timer.unref?.();
    });

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }

    return { promise, cancel: () => { cleanup(); settle?.(); } };
  }
}
