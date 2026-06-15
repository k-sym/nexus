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
