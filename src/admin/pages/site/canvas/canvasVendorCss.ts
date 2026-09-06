/**
 * canvasVendorCss — the vendor `<style>` text `ProjectCssInjector` writes into
 * every canvas iframe, built once instead of once per frame.
 *
 * The bytes are IDENTICAL in every frame: Studio's own bundled design-system
 * stylesheet (a build-time module constant) concatenated with the open
 * project's package CSS, then run through `rewritePrefersColorScheme`. Without
 * a memo each iframe mount re-walked ~122 KB of CSS char-by-char — ~0.40 ms
 * measured on the real `@alm-design/design-system` bundle, which DOES contain
 * a `prefers-color-scheme` query, so `rewritePrefersColorScheme`'s own cheap
 * short-circuit never fires — and re-allocated the joined string, on the
 * frame-mount critical path that a pan or a zoom-out sweeps through.
 *
 * Same mechanism, and the same reason, as `canvasClassCss.ts`'s
 * `createCanvasClassCssMemo` and `canvasUserStylesheetCss.ts`'s two-stage
 * memo — the three injectors' frame-invariant work is now memoised the same
 * way. It lives in its own module rather than in `ProjectCssInjector.tsx`
 * because that file exports a component, and a module that exports both a
 * component and a plain function breaks Fast Refresh
 * (`canvasFastRefreshBoundaries.test.ts`).
 */
// Vite `?inline` yields the processed CSS as a default string export. This is
// STUDIO's OWN dependency, bundled at Studio's own build time — see
// `ProjectCssInjector.tsx`'s module doc, source 1.
import almDesignSystemCss from '@alm-design/design-system/dist/index.css?inline'
import { CANVAS_CSS_LAYER_ORDER, VENDOR_LAYER } from './canvasCssLayers'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'

export type VendorCssBuilder = (projectVendorCss: string) => string

/**
 * Build the single-slot memo. One slot is enough: `projectVendorCss` comes
 * from one module-level external store (`getStudioVendorCss`), so every frame
 * in a commit passes the same string.
 *
 * The factory shape exists so tests can inject a counting rewriter; runtime
 * code uses the bound `buildVendorCss` singleton below.
 */
export function createVendorCssMemo(
  rewrite: (css: string) => string = rewritePrefersColorScheme,
): VendorCssBuilder {
  let lastInput: string | null = null
  let lastOutput = ''
  return (projectVendorCss) => {
    if (lastInput === projectVendorCss) return lastOutput
    const vendorCss = rewrite([almDesignSystemCss as string, projectVendorCss].filter(Boolean).join('\n\n'))
    lastInput = projectVendorCss
    lastOutput = vendorCss
      ? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${VENDOR_LAYER} {\n${vendorCss}\n}`
      : `${CANVAS_CSS_LAYER_ORDER}\n/* no vendor css */`
    return lastOutput
  }
}

/** The vendor `<style>` text for a given project vendor CSS. Identity-memoised — see `createVendorCssMemo`. */
export const buildVendorCss: VendorCssBuilder = createVendorCssMemo()
