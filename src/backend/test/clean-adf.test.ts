import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText } from '../tickets/cleanAdf';

test('adfToText renders paragraphs separated by blank lines', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello there.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second para.' }] },
    ],
  };
  assert.equal(adfToText(doc), 'Hello there.\n\nSecond para.');
});

test('adfToText drops all media/image nodes', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x', type: 'file' } }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Real content.' }] },
      { type: 'mediaInline', attrs: { id: 'y' } },
    ],
  };
  assert.equal(adfToText(doc), 'Real content.');
});

test('adfToText renders bullet list items with bullets', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ],
    }],
  };
  assert.equal(adfToText(doc), '• one\n• two');
});

test('adfToText keeps link text, falling back to href when text is empty', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        { type: 'text', text: 'the docs', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
        { type: 'text', text: ' or ' },
        { type: 'text', text: '', marks: [{ type: 'link', attrs: { href: 'https://bare.test' } }] },
      ],
    }],
  };
  assert.equal(adfToText(doc), 'See the docs or https://bare.test');
});

test('adfToText returns empty string for null/empty docs', () => {
  assert.equal(adfToText(null), '');
  assert.equal(adfToText({ type: 'doc', content: [] }), '');
});

import { trimBoilerplate, cleanAdf } from '../tickets/cleanAdf';

test('trimBoilerplate pulls out a forwarded-header block', () => {
  const text = [
    'FYI please action this.',
    '',
    'From: AWS <no-reply@aws.test>',
    'Sent: 01 May 2026',
    'To: Support',
    'Subject: Action required',
    '',
    'The real body starts here.',
  ].join('\n');
  const result = trimBoilerplate(text);
  assert.match(result.body, /FYI please action this\./);
  assert.match(result.body, /The real body starts here\./);
  assert.doesNotMatch(result.body, /no-reply@aws\.test/);
  assert.ok(result.trimmed.some((t) => t.kind === 'forwarded' && /From: AWS/.test(t.text)));
});

test('trimBoilerplate folds a trailing signature/footer block', () => {
  const text = [
    'Here is the actual content of the ticket.',
    '',
    '--',
    'Jane Smith',
    'Follow us on LinkedIn',
    'Unsubscribe here',
  ].join('\n');
  const result = trimBoilerplate(text);
  assert.equal(result.body, 'Here is the actual content of the ticket.');
  assert.ok(result.trimmed.some((t) => t.kind === 'footer' && /Jane Smith/.test(t.text)));
});

test('trimBoilerplate leaves clean bodies untouched', () => {
  const text = 'Just a normal ticket body with no email cruft.';
  const result = trimBoilerplate(text);
  assert.equal(result.body, text);
  assert.deepEqual(result.trimmed, []);
});

test('cleanAdf composes adfToText + trimBoilerplate', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Body line.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '--' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Unsubscribe here' }] },
    ],
  };
  const result = cleanAdf(doc);
  assert.equal(result.body, 'Body line.');
  assert.ok(result.trimmed.some((t) => t.kind === 'footer'));
});

import { applyContentRules } from '../tickets/cleanAdf';

const HILL = 'Hill Holdings Ltd - email disclaimer*\nThis e-mail and any files distributed with it are intended solely for the individual or organisation to whom it is addressed.|';

test('applyContentRules strips a static pasted chunk verbatim', () => {
  const body = `Please action this.\n\n${HILL}`;
  assert.equal(applyContentRules(body, [HILL]), 'Please action this.');
});

test('applyContentRules matches despite different whitespace/wrapping', () => {
  const reflowed = HILL.replace(/ /g, '\n'); // every space became a newline
  const body = `Top.\n\n${reflowed}`;
  assert.equal(applyContentRules(body, [HILL]), 'Top.');
});

test('applyContentRules matches case-insensitively', () => {
  const body = 'Body.\n\nCONFIDENTIAL: do not forward.';
  assert.equal(applyContentRules(body, ['confidential: do not forward.']), 'Body.');
});

test('applyContentRules wildcard strips a block whose middle varies', () => {
  const rule = 'Reply above this line.\n***\nCGBANNERINDICATOR';
  const t1 = 'Real one.\n\nReply above this line.\n https://x.test/u/AAAA-TOKEN-1\nCGBANNERINDICATOR';
  const t2 = 'Real two.\n\nReply above this line.\n https://x.test/u/BBBB-TOKEN-2\nCGBANNERINDICATOR';
  assert.equal(applyContentRules(t1, [rule]), 'Real one.');
  assert.equal(applyContentRules(t2, [rule]), 'Real two.');
});

test('applyContentRules applies multiple independent rules', () => {
  const body = 'Keep this.\n\nSent from my iPhone\n\nKeep that too.\n\nGet Outlook for iOS';
  const out = applyContentRules(body, ['Sent from my iPhone', 'Get Outlook for iOS']);
  assert.equal(out, 'Keep this.\n\nKeep that too.');
});

test('applyContentRules ignores empty / whitespace-only rules', () => {
  const body = 'Untouched body.';
  assert.equal(applyContentRules(body, ['', '   ', '\n']), 'Untouched body.');
});

test('applyContentRules collapses blank lines left behind', () => {
  const body = 'A.\n\nREMOVE ME\n\nB.';
  assert.equal(applyContentRules(body, ['REMOVE ME']), 'A.\n\nB.');
});

test('cleanAdf applies content rules before the heuristic trim', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Real body.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'CONFIDENTIAL NOTICE: do not forward.' }] },
    ],
  };
  const result = cleanAdf(doc, ['CONFIDENTIAL NOTICE: do not forward.']);
  assert.equal(result.body, 'Real body.');
});

test('cleanAdf with no rules behaves as before', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello.' }] }] };
  assert.equal(cleanAdf(doc).body, 'Hello.');
});
