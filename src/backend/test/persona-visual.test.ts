import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonaVisual } from '../persona-visual';
import { DEFAULT_PERSONA_COLOR } from '@nexus/shared';

test('parses icon and color from config_yaml', () => {
  const yaml = 'name: Dev\nslug: dev\nicon: Wrench\ncolor: "#f59e0b"\n';
  assert.deepEqual(parsePersonaVisual(yaml), { icon: 'Wrench', color: '#f59e0b' });
});

test('falls back to undefined icon and default color when absent', () => {
  const yaml = 'name: Dev\nslug: dev\n';
  assert.deepEqual(parsePersonaVisual(yaml), { icon: undefined, color: DEFAULT_PERSONA_COLOR });
});

test('returns defaults on malformed yaml', () => {
  assert.deepEqual(parsePersonaVisual(':::not yaml:::'), { icon: undefined, color: DEFAULT_PERSONA_COLOR });
});

test('ignores a non-string icon', () => {
  const yaml = 'icon: 42\ncolor: "#fff"\n';
  assert.deepEqual(parsePersonaVisual(yaml), { icon: undefined, color: '#fff' });
});
