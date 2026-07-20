# Glasses bundle optimization

## Outcome

The glasses application now separates simulator scenarios and device-only runtime code from the initial dashboard entry. The production entry decreased from 742.15 KB (233.83 KB gzip) to 198.41 KB (62.56 KB gzip).

## Implementation

- Simulator lab, phase-three, firmware and glyph views load on demand.
- The active glasses runtime loads through a React suspense boundary after the dashboard can render.
- The obsolete root React Router wrapper and direct dependency were removed. The active `AppGlasses3c` implementation does not use the router-dependent legacy hook.
- The interrupt hero uses its existing canvas bell instead of loading React DOM's server renderer and the complete Even Toolkit icon catalogue for one icon.
- Hosted and packaged builds enforce a 225 KB uncompressed entry-bundle budget.

The connected dashboard still requests device chunks immediately because the glasses runtime must initialize. The split chiefly improves first render and keeps simulator-only code out of normal operation; it does not claim that every deferred byte is eliminated.

## Verification

- Run the full workspace build.
- Run the glasses hosted build and confirm the bundle budget passes.
- Run `npm --prefix src/glasses run build:pack` and confirm relative chunk paths are generated for the `.ehpk` package.
- Exercise normal dashboard connection and the `lab-*`, `p3`, `fw`, and `glyphs` simulator query modes.
- On device or in the EvenHub simulator, verify the interrupt hero bell, headline, reason and gesture footer render correctly.
