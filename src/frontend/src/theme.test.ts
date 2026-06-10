import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tailwindConfig = readFileSync(resolve(process.cwd(), 'tailwind.config.js'), 'utf-8');
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');

describe('theme palette contract', () => {
  it('does not override Tailwind zinc or indigo with app-specific colors', () => {
    expect(tailwindConfig).not.toMatch(/\bzinc\s*:/);
    expect(tailwindConfig).not.toMatch(/\bindigo\s*:/);
  });

  it('defines semantic graphite-glass design tokens', () => {
    expect(css).toContain('--surface-canvas:');
    expect(css).toContain('--surface-glass:');
    expect(css).toContain('--border-subtle:');
    expect(css).toContain('--accent:');
    expect(css).toContain('.surface-glass');
    expect(css).toContain('.accent-button');
  });
});
