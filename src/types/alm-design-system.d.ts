/**
 * Ambient shim for `alm-design-system` — the design system vendored at
 * `vendor/alm-design-system/` and wired in as a `file:` dependency.
 *
 * The vendored source is plain `.jsx` with NO type declarations, and it lives
 * outside `src/`, so `tsconfig.app.json`'s `include: ["src"]` keeps it out of
 * `tsc` entirely. The module registration (`src/modules/alm/register.tsx`)
 * reads components off the namespace dynamically
 * (`(DS as Record<string, unknown>)[name]`) and drives their prop inspectors
 * from the generated manifest (`manifest.generated.json`), so an untyped
 * ambient module is the right shim — the real prop shapes live in the
 * manifest, not in package typings.
 *
 * The `?inline` CSS import used by `canvasVendorCss.ts` and the `?raw` SVG
 * imports used by `curatedDefaults.ts` are typed by `vite/client`, not here.
 */
declare module 'alm-design-system'
