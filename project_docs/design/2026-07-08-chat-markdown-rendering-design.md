# Chat Markdown Rendering Design

## Goal

Render assistant chat output as safe Markdown so model responses with headings, lists, inline code, fenced code, and checklists read naturally in Nexus.

## Approved Approach

Use a full Markdown renderer with constrained React components in the shared chat message renderer. User messages remain verbatim. Assistant and tool output can render Markdown, while file paths still use the existing artifact preview button behavior.

## Scope

- Render common GitHub-flavored Markdown in assistant output: headings, paragraphs, lists, task lists, bold/italic, inline code, fenced code blocks, blockquotes, links, tables, and horizontal rules.
- Preserve existing file path preview buttons for assistant output.
- Preserve current image privacy behavior: render images only from GitHub attachment hosts.
- Do not enable raw HTML rendering.
- Keep user-authored chat messages plain and unformatted.

## Implementation Plan

1. Add focused tests in `src/frontend/src/components/ChatMessageContent.test.tsx` for Markdown headings, lists, code blocks, artifact links inside Markdown, unsafe HTML, and image allowlisting.
2. Add Markdown renderer dependencies to the frontend workspace.
3. Replace plain text/image token rendering in `ChatMessageContent.tsx` with a constrained Markdown renderer for assistant output.
4. Update `AgentRunCard.tsx` and `ChatPanel.tsx` wrappers if needed so Markdown controls whitespace rather than `whitespace-pre-wrap`.
5. Run the focused component tests and frontend typecheck.

## Testing Notes

The testing agent should verify:

- Assistant responses render Markdown structure instead of showing literal Markdown punctuation.
- User messages still show literal Markdown text.
- Local file paths still open the artifact preview.
- Non-GitHub images do not auto-load.
- Raw HTML does not execute or become trusted DOM.

## Built Notes

Implemented in the shared chat renderer:

- `ChatMessageContent` now renders assistant/tool output through `react-markdown` with `remark-gfm`.
- Markdown links are constrained to `http:`, `https:`, and `mailto:`.
- Markdown and raw HTML image syntax still only auto-renders GitHub-hosted attachment images.
- Raw HTML rendering remains disabled.
- Artifact path preview buttons are preserved in Markdown prose and inline-code paths.
- User messages keep the non-Markdown path by passing `linkifyPaths={false}`.
- Markdown spacing and table/code/list styles are scoped to `.chat-markdown`.

## File preview follow-up (2026-07-16)

- Markdown files in the right-hand file preview now render through the same GitHub-flavoured Markdown stack and `.chat-markdown` styles instead of displaying raw source.
- The open file-preview rail can be resized from its left edge between 240px and 720px, while preserving space for the main content. The divider also supports Left/Right Arrow keyboard resizing.
- Resizing is opt-in on the shared rail, so the memory rail retains its existing fixed width.
- Verification should cover pointer and keyboard resizing, structured Markdown headings/lists, and unchanged plain-text preview behavior.

Deviation from the initial wording: user messages still preserve the existing GitHub image rendering behavior when sent through `ChatMessageContent` with `linkifyPaths={false}`. They do not get Markdown headings/lists/code parsing.

## Attachment preview and user inline-code follow-up (2026-07-28)

- Restored image thumbnails in the packaged session composers and persisted user-message bubbles by allowing `data:` and `blob:` image sources in the Tauri content security policy.
- Restored chat image previews from the same narrowly allowlisted GitHub attachment hosts already enforced by `ChatMessageContent`; arbitrary remote image hosts remain blocked.
- User messages remain verbatim except for matched, single-line backtick spans, which now use the same inline-code treatment as model messages. Headings, emphasis, lists, fenced code, and artifact-path buttons remain disabled for user-authored text.
- Testing should verify pasted, picked, and dragged images in both session composers; the resulting persisted image in each thread; GitHub attachment previews; and literal versus matched backtick behavior.

Verification performed:

- `npm --workspace=src/frontend test -- ChatMessageContent.test.tsx AgentRunCard.test.tsx ChatPanel.test.tsx AssistantView.test.tsx` passed with 64 tests.
- 2026-07-28: `npm --workspace=src/frontend test -- ChatMessageContent.test.tsx ChatPanel.test.tsx AssistantView.test.tsx` passed with 73 tests.
- 2026-07-28: `npm --workspace=src/frontend run build` passed.
- `npm --workspace=src/frontend run typecheck` passed.
- `npm --workspace=src/frontend test` still fails because `src/components/Sidebar.test.tsx` expects `Project intelligence`; that same Sidebar test fails in isolation and is unrelated to Markdown rendering.

## Tool-boundary paragraph fix (issue #177, 2026-07-16)

Assistant prose emitted before and after tool calls is stored as separate text blocks, but the live stream reducer and history projection previously joined those blocks with an empty string. This produced sentences such as `resources.Now` during a long tool-heavy run.

Built behavior:

- Live chat inserts a Markdown paragraph break when prose resumes after one or more tool calls.
- Existing model-provided newlines are respected and are not duplicated.
- Reloaded session history applies the same block-boundary rule, so the corrected spacing survives navigation and restart.
- Consecutive text chunks without intervening tool activity remain byte-for-byte contiguous.

Testing should verify a response containing `text → tool call → text`, both while streaming and after reloading the thread. It should also verify that a model-provided newline after a tool call is not doubled.

## Native iOS structured Markdown follow-up (2026-08-18)

The shared iOS `StreamingChatView` previously decoded assistant output with
Foundation's `inlineOnlyPreservingWhitespace` mode. Inline emphasis rendered,
but headings, lists, fenced code, block quotes, thematic breaks, and GFM tables
had no block layout; tables therefore appeared as raw pipe-delimited source.

Built behavior:

- `NexusCore` now projects the official `swift-markdown` GFM parse tree into a
  small, UI-free `MarkdownDocument` model. This keeps parsing testable without
  importing SwiftUI into the core package.
- Assistant output in the shared iOS chat renders paragraphs, headings, ordered
  and unordered lists, task items, block quotes, code blocks, thematic breaks,
  and tables as native SwiftUI views. User messages remain literal `Text`.
- Compact-width layouts and accessibility Dynamic Type sizes render each table
  row as a labeled record card. Regular-width layouts render a bordered grid
  with horizontal scrolling only when its content requires it.
- The renderer is shared by Assistant sessions, project Sessions Chat, Idea
  discussions, and the existing chat/assistant deep-link destinations.
- Raw HTML remains inert text. Rendered links are restricted to `https`, `http`,
  and `mailto`, matching the desktop security boundary. Markdown images are not
  fetched by the structured text renderer; existing message attachments retain
  their dedicated native preview path.
- Dynamic Type, selectable text, heading accessibility traits, task-state
  labels, and table summaries are preserved in the native view hierarchy.

Deviation from desktop: tables intentionally become labeled cards on iPhone and
at accessibility text sizes rather than reproducing the desktop grid. This
avoids narrow columns, severe wrapping, and nested horizontal scrolling.

Testing agent should verify:

- The `Repo / Commit / Contents` example renders as one readable card per row on
  an iPhone-sized simulator, with inline commit code and bold cell content.
- The same example renders as a grid on iPad, and remains usable in light/dark
  modes, landscape, and an accessibility Dynamic Type size.
- Headings, nested/numbered/task lists, block quotes, fenced code, safe links,
  raw HTML, and plain user-authored Markdown retain their intended behavior.
- Streaming and rehydrated assistant messages produce the same final structure
  across Assistant, project Sessions Chat, and Idea discussions.

Verification performed:

- `swift test --filter MarkdownDocumentTests` passed (4 tests).
- Full `swift test` passed (80 tests).
- `xcodebuild` for the iPhone 17 / iOS 26.5 simulator succeeded.
