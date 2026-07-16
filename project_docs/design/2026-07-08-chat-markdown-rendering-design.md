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

Verification performed:

- `npm --workspace=src/frontend test -- ChatMessageContent.test.tsx AgentRunCard.test.tsx ChatPanel.test.tsx AssistantView.test.tsx` passed with 64 tests.
- `npm --workspace=src/frontend run typecheck` passed.
- `npm --workspace=src/frontend test` still fails because `src/components/Sidebar.test.tsx` expects `Project intelligence`; that same Sidebar test fails in isolation and is unrelated to Markdown rendering.
