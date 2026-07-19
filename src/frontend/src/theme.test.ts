import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');
const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf-8');
const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

describe('theme palette contract', () => {
  it('uses the Tailwind 4 Vite integration and keeps the app theme CSS-first', () => {
    expect(viteConfig).toContain("from '@tailwindcss/vite'");
    expect(viteConfig).toContain('tailwindcss()');
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain('--color-ink: var(--accent-foreground);');
    expect(css).not.toMatch(/--color-(?:zinc|indigo)-/);
  });

  it('defines semantic graphite-glass design tokens', () => {
    expect(css).toContain('--surface-canvas:');
    expect(css).toContain('--surface-glass:');
    expect(css).toContain('--border-subtle:');
    expect(css).toContain('--accent:');
    expect(css).toContain('--accent-foreground: #071014');
    expect(css).toContain('.surface-glass');
    expect(css).toContain('.accent-button');
  });

  it('uses current accent colors for scrollbar styling', () => {
    expect(css).toContain('::-webkit-scrollbar-thumb');
    expect(css).toContain('background: rgba(137, 232, 203, 0.26)');
    expect(css).toContain('background: rgba(137, 232, 203, 0.46)');
    expect(css).not.toContain('rgba(167, 139, 250');
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

  it('uses the selected light content islands palette while neutralizing the starfield glow', () => {
    expect(css).toContain('@keyframes ambient-twinkle');
    expect(css).toContain('--surface-canvas: #101417');
    expect(css).toContain('--surface-panel: rgba(21, 29, 33, 0.94)');
    expect(css).toContain('--surface-elevated: rgba(39, 52, 58, 0.90)');
    expect(css).toContain('--accent: #89e8cb');
    expect(css).toContain('background: rgba(8, 13, 16, 0.96)');
    expect(css).toContain('background: rgba(39, 52, 58, 0.82)');
    expect(css).toContain('background-image: none');
    expect(css).toContain('opacity: 0');
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
