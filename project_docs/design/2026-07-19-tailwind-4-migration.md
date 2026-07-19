# Tailwind CSS 4 migration

## Scope

Migrate the Nexus frontend from Tailwind CSS 3 and its PostCSS integration to Tailwind CSS 4 using Tailwind's first-party Vite plugin. Preserve the existing graphite-glass visual language and semantic CSS tokens.

## Implementation

- Replaced the three legacy `@tailwind` directives with the Tailwind 4 `@import "tailwindcss"` entrypoint.
- Replaced the PostCSS plugin configuration with `@tailwindcss/vite` in the frontend Vite configuration.
- Moved the custom `ink` colour utility from the JavaScript configuration into the CSS-first theme as `--color-ink`.
- Removed the obsolete Tailwind JavaScript and PostCSS configuration files, along with direct `autoprefixer` and `postcss` dependencies.
- Applied Tailwind's v4 replacements for renamed radius, backdrop-blur, outline, and shrink utilities so existing visuals and forced-colour focus behaviour are preserved.
- Retained the previous pointer cursor for enabled buttons and button roles after the Tailwind 4 Preflight change.
- Updated the theme contract test to cover the Tailwind 4 integration and guard the CSS-first palette configuration.

## Deviations

The migration deliberately makes no visual redesign. The existing desktop-oriented shell still overflows horizontally at a 375px viewport; this predates the dependency change and is not addressed in this migration.

## Verification

- Run frontend unit tests, type checking, and the production build.
- Compare the primary shell, navigation, chat, mission-control, and settings views before and after migration at desktop and 375px widths.
- Verify focus indicators, disabled states, dark-theme contrast, scrolling, and reduced-motion behaviour remain intact.
