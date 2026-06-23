import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tailwindConfig = readFileSync(resolve(process.cwd(), 'tailwind.config.js'), 'utf-8');
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');
const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

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

  it('defines the ambient shell and open kanban lane contract', () => {
    expect(css).toContain('.ambient-shell');
    expect(css).toContain('.ambient-shell::before');
    expect(css).toContain('.ambient-shell::after');
    expect(css).toContain('@keyframes ambient-drift');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.kanban-lane');
    expect(css).toContain('.kanban-card');
    expect(app).toContain('ambient-shell surface-canvas');
  });

  it('disables run-card status animations when reduced motion is requested', () => {
    expect(css).toContain('.agent-run-card .animate-spin');
    expect(css).toContain('.agent-run-card .animate-pulse');
    expect(css).toContain('animation: none !important');
  });

  it('keeps the starfield opt-in animated with gradient-based glow', () => {
    expect(css).toContain('@keyframes ambient-twinkle');
    expect(css).toContain('2.6px');
    expect(css).toContain('rgba(190, 242, 255, 0.07) 7px');
    expect(css).toContain('.ambient-animate .ambient-shell::after');
    expect(css).toContain('ambient-drift 22s');
  });

  it('defines layered ambient particles with independent motion', () => {
    expect(app).toContain('ambient-particle-layer ambient-particles-far');
    expect(app).toContain('ambient-particle-layer ambient-particles-mid');
    expect(app).toContain('ambient-particle-layer ambient-particles-near');
    expect(css).toContain('.ambient-particle-layer');
    expect(css).toContain('.ambient-particles-far');
    expect(css).toContain('.ambient-particles-mid');
    expect(css).toContain('.ambient-particles-near');
    expect(css).toContain('@keyframes ambient-drift-far');
    expect(css).toContain('@keyframes ambient-drift-mid');
    expect(css).toContain('@keyframes ambient-drift-near');
    expect(css).toContain('ambient-drift-far 38s');
    expect(css).toContain('ambient-drift-mid 27s');
    expect(css).toContain('ambient-drift-near 18s');
  });
});
