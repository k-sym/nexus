# Frontend quality gates

## Scope

Add pull-request checks for the Nexus desktop frontend and deterministic visual regression coverage for its primary surfaces.

## Implementation

- GitHub Actions runs the frontend unit tests, typecheck, and production build for frontend and shared-package changes.
- Playwright runs Chromium screenshot comparisons at a fixed 1280×720 desktop viewport with reduced motion, fixed locale/timezone, and mocked API responses.
- Baselines cover Mission Control, Assistant, Settings, and the new-project modal.
- Failed visual runs upload the Playwright report, actual screenshot, expected baseline, and pixel diff for diagnosis.

## Browser support

The Nexus web renderer follows the Tailwind CSS 4 platform floor: Safari 16.4+, Chrome 111+, and Firefox 128+. The packaged Tauri desktop application is the primary target and must use a WebView version capable of those browser features.

Narrow/mobile layouts are not a supported target. If Nexus expands to mobile, responsive web work should be evaluated separately from a native iOS application rather than inferred from this desktop UI.

## Deviations

The screenshot tolerance permits up to a 3% changed-pixel ratio to absorb small cross-platform font-rendering differences between local macOS baseline generation and Linux CI. Large layout, colour, spacing, visibility, and component regressions still fail.

## Verification

- Run frontend unit tests, typecheck, and build.
- Generate and review all four screenshot baselines.
- Run the visual suite again without updating snapshots to prove comparisons are stable.
- Verify the workflow syntax and confirm failed visual tests retain diagnostic artifacts.
