/**
 * canvasFrameCss — the canvas-only transforms a portal frame applies to
 * project CSS text before injecting it, in one function, so every injector
 * that carries project CSS applies the same ones in the same order:
 *
 *   1. site-root `url()`s resolve to the project asset route
 *      (`canvasProjectAssetUrl.ts`, P5-B2) — the frame is on the admin
 *      origin, which serves nothing at `/bg.png`;
 *   2. viewport units pin to the frame's viewport
 *      (`resolveViewportUnits.ts`) so `vh` cannot feed the grow-to-content
 *      height loop;
 *   3. `prefers-color-scheme` follows the frame's previewed scheme
 *      (`darkSchemeCssTransform.ts`).
 *
 * Each of these used to be composed by hand at every call site
 * (`AuthoredCssInjector` and the three `ClassStyleInjector` effects); a new
 * transform added to one and forgotten in another would make the same rule
 * render differently depending on which sheet it came from.
 * `canvasUserStylesheetCss.ts` runs the same three through its own staged
 * memo, because its first stage is shared by every frame.
 *
 * None of this reaches the publisher: the published CSS keeps the author's
 * URLs, units and media queries.
 */
import { canvasProjectAssetScope, projectAssetCssUrls } from './canvasProjectAssetUrl'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'

export function canvasFrameCss(css: string, viewport: CanvasViewport | undefined): string {
  const withAssets = projectAssetCssUrls(css, canvasProjectAssetScope())
  const pinned = viewport ? resolveViewportUnitsForCanvas(withAssets, viewport) : withAssets
  return rewritePrefersColorScheme(pinned)
}
