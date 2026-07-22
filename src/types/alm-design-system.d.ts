/**
 * Ambient shim for `@alm-design/design-system`.
 *
 * The published package ships a bundled `dist/index.js` + `dist/index.css` with
 * NO type declarations. The design-system module registration
 * (`src/modules/alm/register.tsx`) reads the components off the namespace
 * dynamically (`(DS as Record<string, unknown>)[name]`) and drives their prop
 * inspectors from the generated manifest (`manifest.generated.json`), so an
 * untyped ambient module is the right shim — the real prop shapes live in the
 * manifest, not in package typings.
 *
 * The `?inline` CSS import used by `AlmDesignSystemCssInjector` is typed by
 * `vite/client`, not here.
 */
declare module '@alm-design/design-system'
