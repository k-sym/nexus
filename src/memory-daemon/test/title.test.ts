import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitleLine, deriveTitle } from "../src/sync/title.js";

const file = "/vault/Memories/01ABC.md";

test("legacy archive shape: short key-value lines yield to the first real phrase", () => {
  const body = "**Project:** Nexus\n**Session:** Change Active Project Status Badge Color\n\nbody";
  assert.equal(deriveTitle(body, file), "Change Active Project Status Badge Color");
});

test("bold key-value line reduces to its value", () => {
  assert.equal(deriveTitle("**Session Summary: Nexus iOS App Improvements**\n\ntext", file), "Nexus iOS App Improvements");
});

test("a table-first body takes the next usable line", () => {
  const body = "| Resource | `Thing` — key |\n|---|---|\n| a | b |\n\nThe audit resource resolves distribution lazily.";
  assert.equal(deriveTitle(body, file), "The audit resource resolves distribution lazily.");
});

test("a sentence with a quoted phrase before a colon stays whole", () => {
  const line = 'Completed "Audit report emails": Let me start by getting the list';
  assert.equal(cleanTitleLine(line), line);
});

test("a colon sentence with a long key stays whole", () => {
  const line = "Two findings in Nexus today after the review: both are about pins";
  assert.equal(cleanTitleLine(line), line);
});

test("an H1 after a code fence containing a fake heading wins over the fence", () => {
  const body = "```bash\n# fake\n```\n\n# Real title\n\ntext";
  assert.equal(deriveTitle(body, file), "Real title");
});

test("a fenced first line is skipped for the fallback too", () => {
  const body = "```\n# fake\nstuff here\n```\nActual first prose line here.";
  assert.equal(deriveTitle(body, file), "Actual first prose line here.");
});

test("a long first line is cut at a word boundary under 120 chars", () => {
  const body = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const title = deriveTitle(body, file);
  assert.ok(title.length <= 120, `${title.length} chars`);
  assert.ok(!title.endsWith(" "));
  assert.ok(body.startsWith(title));
  assert.match(title, /word\d+$/);
});

test("list item with bold, code and a link cleans to plain text", () => {
  assert.equal(cleanTitleLine("- **Bold item** with `code` and [a link](https://x.y)"), "Bold item with code and a link");
  assert.equal(cleanTitleLine("> 1. *Quoted* numbered _item_ here:"), "Quoted numbered item here");
});

test("structure-only bodies fall back to the filename", () => {
  const body = "| a | b |\n|---|---|\n\n---\n\n![img](x.png)\n\n<!-- note -->\n\nOne\n";
  assert.equal(deriveTitle(body, file), "01ABC");
});

test("a leading date parenthetical on session-flush captures is kept", () => {
  const line = "(2026-08-19) The client-side category guard prevents a real data-loss path";
  assert.equal(cleanTitleLine(line), line);
});

test("CRLF bodies derive the same title", () => {
  assert.equal(deriveTitle("**Project:** Nexus\r\n**Session:** Fix the badge colour\r\n", file), "Fix the badge colour");
});

test("an explicit H1 keeps its Key: prefix and only loses markdown syntax", () => {
  assert.equal(deriveTitle("# Project Memory: App Wise - 503 Error Investigation\n\ntext", file), "Project Memory: App Wise - 503 Error Investigation");
  assert.equal(deriveTitle("# **Bold** `code` [link](u)\n", file), "Bold code link");
  assert.equal(deriveTitle("# Notes\n\ntext", file), "Notes");
});
