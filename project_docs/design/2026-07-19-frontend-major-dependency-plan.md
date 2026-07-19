# Frontend major dependency migration plan

## Objective

Handle the remaining frontend development-tool majors as explicit, independently reviewable migrations after the Tailwind CSS 4 work.

## Sequence

### 1. jsdom 29

- Upgrade `jsdom` from 25 to 29 in an isolated PR.
- Run all Vitest suites and review DOM, storage, URL, navigation, and event-behaviour changes.
- Remove or update test shims only when the new behaviour matches browser standards.
- Exit criteria: all frontend tests, typecheck, build, and visual regression checks pass.

### 2. Node.js type definitions 26

- Confirm the runtime support policy before upgrading `@types/node` from 22 to 26.
- Prefer keeping type definitions aligned with the Node version used in CI and packaged services; do not adopt Node 26-only APIs while the runtime floor remains Node 20/22.
- Resolve newly exposed type incompatibilities without weakening compiler strictness.
- Exit criteria: workspace typecheck, backend/frontend builds, and relevant service tests pass on the supported Node matrix.

### 3. TypeScript 7

- Upgrade TypeScript only after its runtime/tooling compatibility is confirmed across Vite, Vitest, Tauri, backend, shared code, glasses, and memory daemon packages.
- Review release notes for removed compiler options, stricter inference, module resolution, decorators, and declaration-output changes.
- Upgrade package-by-package where separate lockfiles exist, beginning with the root workspace and leaving glasses/memory-daemon follow-ups isolated if necessary.
- Exit criteria: all workspace builds, typechecks, tests, package builds, and visual regression checks pass with no broad type-safety suppressions.

## Dependabot handling

Keep the existing major-version Dependabot PRs open only as migration signals. Do not merge them automatically; supersede or close each after its explicit migration PR is validated.

## Risk controls

- One major dependency family per PR.
- No unrelated feature or UI changes.
- Record observed breaking changes and required verification in the PR description.
- Preserve rollback by avoiding combined lockfile migrations where practical.
