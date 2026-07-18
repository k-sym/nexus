# Security dependency major upgrades

## Implementation

The dependency groups identified by `npm audit` were migrated to advisory-free releases:

- Frontend: Vite 8.1, Vitest 4.1, and `@vitejs/plugin-react` 6.
- Glasses app: Vite 8.1, `@vitejs/plugin-react` 6, and TypeScript 5.9.
- Backend: `@fastify/static` 10.1.
- Root runtime contract: Node.js 20.19 or newer, matching Vite 8's minimum supported Node release.

The frontend now declares `@types/node` directly because Vitest 4 no longer provides the Node globals used by test files as an incidental transitive type dependency.

## Deviations

Tailwind remains on version 3 because it was not part of the advisory chain and its version 4 migration changes the CSS/PostCSS integration. Other unrelated major upgrades remain outside this security-focused change.

## Verification

Testing should verify frontend development/production startup, static asset serving in packaged builds, and the glasses dashboard build/pack flow.

Automated verification completed with zero npm audit findings across the root workspace, glasses app, and memory daemon; 429 backend tests; 267 frontend tests; 20 daemon tests; the full workspace type-check/build; the glasses build; and Tauri `cargo check`.
