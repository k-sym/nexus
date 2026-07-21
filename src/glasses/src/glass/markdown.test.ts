import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toGlassText } from './markdown.ts'

test('strips the emphasis that started this — bold and inline code', () => {
  // The exact line that was on the lens when we caught this.
  const md = 'Yes! I can see the **glasses app** at `apps/even-glasses/`. Let me take a quick look.'
  assert.equal(
    toGlassText(md),
    'Yes! I can see the glasses app at apps/even-glasses/. Let me take a quick look.',
  )
})

test('flattens the rest of the inline syntax', () => {
  assert.equal(toGlassText('*italic* and __also bold__ and ~~struck~~'), 'italic and also bold and struck')
  assert.equal(toGlassText('***both at once***'), 'both at once')
  assert.equal(toGlassText('see [the docs](https://example.com/x) now'), 'see the docs now')
  assert.equal(toGlassText('![a diagram](d.png) follows'), 'a diagram follows')
  assert.equal(toGlassText('mail <https://example.com/a> here'), 'mail https://example.com/a here')
  assert.equal(toGlassText('an escaped \\*star\\* stays'), 'an escaped *star* stays')
})

test('leaves identifiers alone', () => {
  // The reason code spans are lifted before the emphasis passes run.
  assert.equal(toGlassText('`some_snake_case_name` and file_path_here'), 'some_snake_case_name and file_path_here')
  assert.equal(toGlassText('a * b * c stays multiplied'), 'a * b * c stays multiplied')
})

test('drops block markers but keeps the words', () => {
  assert.equal(toGlassText('## What I changed'), 'What I changed')
  assert.equal(toGlassText('### Closed heading ###'), 'Closed heading')
  assert.equal(toGlassText('> quoted advice'), 'quoted advice')
  assert.equal(toGlassText('>> nested quote'), 'nested quote')
  assert.equal(toGlassText('- one\n* two\n+ three'), '• one\n• two\n• three')
  assert.equal(toGlassText('1. numbered stays'), '1. numbered stays')
})

test('drops rules and table scaffolding', () => {
  assert.equal(toGlassText('above\n\n---\n\nbelow'), 'above\n\nbelow')
  assert.equal(toGlassText('above\n***\nbelow'), 'above\nbelow')
  assert.equal(
    toGlassText('| file | status |\n| --- | --- |\n| a.ts | done |'),
    'file · status\na.ts · done',
  )
})

test('keeps fenced code contents, drops the fences', () => {
  const md = 'run this:\n```bash\nnpm test\n```\nthen check'
  assert.equal(toGlassText(md), 'run this:\nnpm test\nthen check')
})

test('does not flatten markdown inside a fence', () => {
  const md = '```\nconst a = **not bold**\n```'
  assert.equal(toGlassText(md), 'const a = **not bold**')
})

test('reclaims vertical space', () => {
  // Blank-line runs and trailing spaces cost rows and wrap budget on a 7-line HUD.
  assert.equal(toGlassText('one\n\n\n\n\ntwo'), 'one\n\ntwo')
  assert.equal(toGlassText('trailing   \nspaces   '), 'trailing\nspaces')
  assert.equal(toGlassText('\n\n  padded  \n\n'), 'padded')
})

test('handles nothing gracefully', () => {
  assert.equal(toGlassText(''), '')
  assert.equal(toGlassText('\n\n'), '')
  assert.equal(toGlassText('plain prose, untouched'), 'plain prose, untouched')
})
