import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInteractiveRole, keyDefinition, quadCenter, SUPPORTED_KEYS } from '../browser/input';

test('interactive roles are the actionable subset, not static content', () => {
  for (const role of ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'option']) {
    assert.equal(isInteractiveRole(role), true, role);
  }
  // Static content must not get a ref — it would bloat the tree and invite
  // clicks on things that do nothing.
  for (const role of ['heading', 'StaticText', 'paragraph', 'image', 'generic', 'none']) {
    assert.equal(isInteractiveRole(role), false, role);
  }
});

test('named keys resolve, case-tolerantly, and unknown keys are rejected', () => {
  const enter = keyDefinition('Enter');
  assert.equal(enter?.windowsVirtualKeyCode, 13);
  assert.equal(enter?.key, 'Enter');
  // Enter carries a character so a keypress can submit / insert a newline.
  assert.equal(enter?.text, '\r');

  // Lowercase is a common model phrasing.
  assert.equal(keyDefinition('enter')?.windowsVirtualKeyCode, 13);
  assert.equal(keyDefinition('  tab  ')?.key, 'Tab');
  assert.equal(keyDefinition('ArrowDown')?.windowsVirtualKeyCode, 40);

  // A typo must not silently become a no-op keypress.
  assert.equal(keyDefinition('Retrun'), null);
  assert.equal(keyDefinition(''), null);

  // Non-printable keys carry no text (they'd otherwise insert stray characters).
  assert.equal(keyDefinition('Tab')?.text, undefined);
  assert.equal(keyDefinition('Escape')?.text, undefined);
});

test('SUPPORTED_KEYS covers the page-driving essentials', () => {
  for (const key of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'Backspace']) {
    assert.ok(SUPPORTED_KEYS.includes(key), key);
  }
});

test('quadCenter averages the four corners of a box-model quad', () => {
  // A 100x40 box at (10,20): corners (10,20)(110,20)(110,60)(10,60) → center (60,40).
  assert.deepEqual(quadCenter([10, 20, 110, 20, 110, 60, 10, 60]), { x: 60, y: 40 });
  // A degenerate / missing quad has no center rather than NaN coordinates.
  assert.equal(quadCenter([]), null);
  assert.equal(quadCenter([1, 2, 3]), null);
});
