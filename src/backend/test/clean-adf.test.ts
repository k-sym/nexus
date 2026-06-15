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
