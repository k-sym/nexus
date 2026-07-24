/**
 * The Nexus orientation block injected into a session's system prompt.
 *
 * The individual tools already advertise themselves (Pi folds each tool's
 * `promptSnippet` into the prompt, and Nexus only registers a tool when it's
 * usable). What that leaves out is the *framing* — the things about running
 * inside Nexus that the repo and the tool list alone don't convey: that memory
 * persists across sessions and is worth leaning on, that this project keeps its
 * thinking under `project_docs/`, and that front-end work can be verified rather
 * than shipped blind. That is what this block supplies.
 *
 * It goes through `systemPromptOverride` (like the Monday block), which Pi
 * re-evaluates on every session create and resume — so a thread reopened next
 * week reflects the capabilities it has *then*, not a line frozen at first
 * creation. Per-project conventions are deliberately NOT here: Pi already loads
 * a repo's `AGENTS.md`, which is their home; this block only points at where the
 * docs live and orients the agent to the environment.
 *
 * Every line is conditional on the session actually having the capability, so
 * the block can never promise a tool that isn't registered. Screenshots are
 * mentioned only when the selected model can see images.
 *
 * #274.
 */

export interface OrientationInput {
  /** `memory_recall` is registered — the memory daemon is configured. */
  hasMemory: boolean;
  /** `docker_service` is registered — Docker is enabled and reachable. */
  hasDocker: boolean;
  /** The browser tools are registered — enabled and a browser was found. */
  hasBrowser: boolean;
  /** The session's model accepts image input — so a screenshot is worth taking. */
  hasVision: boolean;
}

/** Whether a `provider/id` model key resolves to a vision-capable model.
 *  Takes a lookup fn rather than a registry so it's testable in isolation. */
export function modelKeyHasVision(
  modelKey: string | undefined,
  find: (provider: string, id: string) => { input?: Array<'text' | 'image'> } | undefined,
): boolean {
  if (!modelKey) return false;
  const sep = modelKey.indexOf('/');
  if (sep <= 0) return false;
  const model = find(modelKey.slice(0, sep), modelKey.slice(sep + 1));
  return Array.isArray(model?.input) && model.input.includes('image');
}

/**
 * Build the orientation block. Always includes the intro and the `project_docs`
 * pointer; the rest appears only when the capability is present. Returns a
 * markdown string with no trailing newline (the caller joins it).
 */
export function buildOrientationBlock(input: OrientationInput): string {
  const lines: string[] = [
    '# Working in Nexus',
    '',
    "You're running inside Nexus. A few things about this environment that the repo alone won't tell you:",
    '',
  ];

  if (input.hasMemory) {
    lines.push(
      '- **Memory persists across sessions.** Nexus keeps per-project memory of past decisions and '
      + 'their rationale. When something turns on history you cannot read from the code, recall it '
      + 'with `memory_recall` rather than guessing.',
    );
  }

  lines.push(
    '- **This project keeps its own docs** under `project_docs/` — typically `specs/`, `plans/`, and '
    + '`design/`. Read them for context, and write specs and plans there rather than only in chat.',
  );

  if (input.hasDocker) {
    lines.push(
      "- **You can run this project's services** with `docker_service` to test against them, instead of "
      + 'only reasoning about them.',
    );
  }

  if (input.hasBrowser) {
    const screenshot = input.hasVision
      ? ', screenshot it to see the result yourself'
      : '';
    lines.push(
      '- **You can verify front-end work in a real browser** — load a page, read what rendered, '
      + `interact with it${screenshot}, and resize the viewport or switch \`prefers-color-scheme\` `
      + 'to check responsive and dark-mode states — instead of shipping UI blind. Whatever page the '
      + 'browser is on is mirrored live into this chat for the person watching, so front-end work is '
      + 'visible as it happens.',
    );
  }

  return lines.join('\n');
}
