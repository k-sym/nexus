import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breadcrumb,
  chunkDocument,
  countWords,
  sizeSection,
  splitIntoChunks,
  splitIntoSentences,
  splitMarkdownSections,
} from "../src/index/chunk.js";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

test("splitIntoChunks defaults stay below the local embedder token limit with margin", () => {
  const text = Array.from({ length: 650 }, (_, i) => `archive-memory-token-${i}`).join(" ");

  const chunks = splitIntoChunks(text);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(countWords(chunk) <= 180, `expected <= 180 words, got ${countWords(chunk)}`);
  }
});

test("splitIntoChunks has no overlap by default", () => {
  const chunks = splitIntoChunks(words(400));
  const seen = new Set<string>();
  for (const c of chunks) {
    for (const w of c.split(" ")) {
      assert.ok(!seen.has(w), `word ${w} repeated across chunks`);
      seen.add(w);
    }
  }
  assert.equal(seen.size, 400);
});

test("heading sections become one chunk each, in document order, with breadcrumbs", () => {
  const chunks = chunkDocument("T", "# T\n\n## A\n\nfoo\n\n## B\n\nbar\n");
  assert.deepEqual(
    chunks.map((c) => c.text),
    ["T › A\n\nfoo", "T › B\n\nbar"],
  );
  assert.deepEqual(chunks.map((c) => c.source), ["foo", "bar"]);
});

test("a frontmatter title that differs from the H1 keeps both in the breadcrumb", () => {
  const chunks = chunkDocument("X", "# Y\n\n## Z\n\nbody");
  assert.equal(chunks[0].text, "X › Y › Z\n\nbody");
});

test("breadcrumb drops a leading path entry that repeats the title", () => {
  assert.equal(breadcrumb("Note", ["note", "Sec"]), "Note › Sec");
  assert.equal(breadcrumb("Note", ["Other", "Sec"]), "Note › Other › Sec");
  assert.equal(breadcrumb("Note", []), "Note");
});

test("a section over the cap yields several chunks with the same breadcrumb and no repeated words", () => {
  const body = `# T\n\n## Long\n\n${words(500)}\n`;
  const chunks = chunkDocument("T", body);
  assert.ok(chunks.length > 1);
  const seen = new Set<string>();
  for (const c of chunks) {
    assert.ok(c.text.startsWith("T › Long\n\n"), c.text.slice(0, 20));
    assert.ok(countWords(c.text) <= 180, `chunk has ${countWords(c.text)} words`);
    for (const w of c.source.split(/\s+/)) {
      assert.ok(!seen.has(w), `word ${w} repeated`);
      seen.add(w);
    }
  }
  assert.equal(seen.size, 500);
});

test("sizeSection prefers paragraph boundaries, then sentences, then a word window", () => {
  const paras = [words(60, "a"), words(60, "b"), words(60, "c")];
  const byPara = sizeSection(paras.join("\n\n"), 130);
  assert.deepEqual(byPara, [`${paras[0]}\n\n${paras[1]}`, paras[2]]);

  const sentences = ["Alpha one two three four.", "Beta one two three four.", "Gamma one two three four."];
  const bySentence = sizeSection(sentences.join(" "), 10);
  assert.deepEqual(bySentence, [`${sentences[0]} ${sentences[1]}`, sentences[2]]);

  const noPunctuation = words(50);
  const byWindow = sizeSection(noPunctuation, 20);
  assert.equal(byWindow.length, 3);
  assert.ok(byWindow.every((p) => countWords(p) <= 20));
});

test("sentences derive from the section piece only, never the breadcrumb", () => {
  const chunks = chunkDocument("T", "# T\n\n## A\n\nFirst sentence here. Second sentence here.");
  for (const c of chunks) {
    const sents = splitIntoSentences(c.source);
    assert.ok(sents.length >= 2);
    assert.ok(sents.every((s) => !s.includes("›")), JSON.stringify(sents));
  }
});

test("a # inside a code fence does not start a section", () => {
  const body = "# T\n\n## Code\n\n```bash\n# not a heading\necho hi\n```\n\nafter\n";
  const sections = splitMarkdownSections(body);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].path, ["T", "Code"]);
  assert.ok(sections[0].text.includes("# not a heading"));
  assert.ok(sections[0].text.endsWith("after"));
});

test("a body with no headings is one section prefixed with the title only", () => {
  const chunks = chunkDocument("Plain", "just some text\n\nand more");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "Plain\n\njust some text\n\nand more");
});

test("headings with no text under them yield no chunk; deeper headings fold into the path", () => {
  const body = "# T\n\n## Parent\n\n### Child\n\ntext\n\n#### Deep\n\nmore\n\n## Next\n\nlast";
  const sections = splitMarkdownSections(body);
  assert.deepEqual(
    sections.map((s) => s.path),
    [["T", "Parent", "Child"], ["T", "Parent", "Deep"], ["T", "Next"]],
  );
  assert.deepEqual(sections.map((s) => s.text), ["text", "more", "last"]);
});

test("CRLF bodies split the same as LF bodies", () => {
  const lf = chunkDocument("T", "# T\n\n## A\n\nfoo\n\n## B\n\nbar");
  const crlf = chunkDocument("T", "# T\r\n\r\n## A\r\n\r\nfoo\r\n\r\n## B\r\n\r\nbar");
  assert.deepEqual(crlf, lf);
});

test("a note whose headings start at H2 keeps sibling H2s as siblings", () => {
  const chunks = chunkDocument("Roll-up", "## Summary\n\nmet.\n\n## Decisions\n\ndrop overlap.\n\n### Why\n\nalignment.");
  assert.deepEqual(
    chunks.map((c) => c.text),
    ["Roll-up › Summary\n\nmet.", "Roll-up › Decisions\n\ndrop overlap.", "Roll-up › Decisions › Why\n\nalignment."],
  );
});
