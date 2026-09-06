/**
 * canvasUserStylesheetCss — the user-stylesheet transform chain
 * `UserStylesheetInjector` injects into each canvas iframe, split into a
 * frame-INVARIANT stage and a frame-VARIANT stage and memoised across frames.
 *
 * Every mounted iframe runs the same chain in the same commit, over the same
 * store snapshot. Measured on a real ~178 KB project CSS corpus:
 *
 *   collectUserStylesheetCss   frame-invariant   (files + scope only)
 *   rewritePrefersColorScheme  frame-invariant   ~0.83 ms per call
 *   resolveViewportUnitsForCanvas  frame-VARIANT ~10.95 ms per call
 *
 * So of a 6-frame board's chain, only the last step genuinely differs per
 * frame — and even that differs only by frame WIDTH, which board frames
 * routinely share (a board of phone screens is one width). Stage A therefore
 * runs once per store snapshot and stage B once per distinct viewport.
 *
 * **The stage order is the reverse of what the injector used to do**, and that
 * reordering is what makes stage A frame-invariant at all: the chain was
 * `collect → resolveViewportUnits → rewritePrefersColorScheme`, which makes
 * the scheme rewrite depend on the viewport and therefore uncacheable across
 * frames. The two transforms commute — `resolveViewportUnitsForCanvas` only
 * rewrites `<number><viewport-unit>` tokens inside DECLARATIONS (skipping
 * comments, strings and `url()`), while `rewritePrefersColorScheme` only
 * rewrites SELECTOR text and the `@media` prelude of a
 * `(prefers-color-scheme: …)` block, preserving declarations byte-for-byte.
 * Verified empirically, not just argued: both orders produce byte-identical
 * output over all 351 `.css` files in `studio-workspace/` at two viewports,
 * and `canvasUserStylesheetCss.test.ts` pins the property on the shapes that
 * make it interesting (viewport units inside a dark-mode block, a quoted
 * attribute selector, a `url()`).
 *
 * Same mechanism as `canvasClassCss.ts`'s `createCanvasClassCssMemo` — see
 * that module for the "all inputs are Mutative-immutable, so identity
 * comparison is exact" argument this relies on.
 */
import type { SiteDocument } from '@core/page-tree'
import { collectUserStylesheetCss } from '@core/publisher'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'

/**
 * The two fields of the active canvas page that user-stylesheet SCOPE matching
 * reads — see `collectUserStylesheetCss`'s own doc for why node content is
 * irrelevant here. Primitives, so the memo below can key on them across
 * frames: each `UserStylesheetInjector` instance has its OWN `useShallow`
 * subscription and therefore its own object identity for the same two values,
 * which is exactly why this memo must not key on the object.
 */
export interface UserStylesheetScope {
  id: string
  template: boolean
}

export type UserStylesheetCssBuilder = (
  site: SiteDocument | null,
  scope: UserStylesheetScope | null,
  viewport: CanvasViewport | undefined,
) => string

interface Transforms {
  collect: typeof collectUserStylesheetCss
  rewriteScheme: (css: string) => string
  resolveViewport: typeof resolveViewportUnitsForCanvas
}

const DEFAULT_TRANSFORMS: Transforms = {
  collect: collectUserStylesheetCss,
  rewriteScheme: rewritePrefersColorScheme,
  resolveViewport: resolveViewportUnitsForCanvas,
}

/** `undefined` viewport (non-iframe contexts) gets its own cache slot, distinct from any real one. */
function viewportKey(viewport: CanvasViewport | undefined): string {
  return viewport ? `${viewport.width}x${viewport.height}` : 'none'
}

/**
 * Build the two-stage memo. The factory shape exists so tests can inject
 * counting transforms; runtime code uses the bound `buildUserStylesheetCss`
 * singleton below.
 */
export function createUserStylesheetCssMemo(
  transforms: Transforms = DEFAULT_TRANSFORMS,
): UserStylesheetCssBuilder {
  // Stage A — frame-invariant. Single slot: every frame in a commit passes the
  // SAME `(site, scope)`, so one slot is all the sweep can ever need.
  let lastSite: SiteDocument | null | undefined
  let lastScopeId: string | null | undefined
  let lastScopeTemplate: boolean | undefined
  let schemeRewritten = ''

  // Stage B — one slot per distinct viewport, dropped whenever stage A's
  // output changes. A `Map` rather than a single slot for the same reason
  // `store.ts`'s `_canvasPageForCache` needs one: within ONE commit this is
  // called with several different viewports, so a single slot would thrash.
  let byViewport = new Map<string, string>()

  return (site, scope, viewport) => {
    const scopeId = scope ? scope.id : null
    const scopeTemplate = scope ? scope.template : false
    if (site !== lastSite || scopeId !== lastScopeId || scopeTemplate !== lastScopeTemplate) {
      const collected = site && scope ? transforms.collect(site, scope) : ''
      schemeRewritten = transforms.rewriteScheme(collected)
      lastSite = site
      lastScopeId = scopeId
      lastScopeTemplate = scopeTemplate
      byViewport = new Map()
    }

    const key = viewportKey(viewport)
    const cached = byViewport.get(key)
    if (cached !== undefined) return cached
    const resolved = viewport ? transforms.resolveViewport(schemeRewritten, viewport) : schemeRewritten
    byViewport.set(key, resolved)
    return resolved
  }
}

/** The user-authored CSS for one canvas frame. Memoised across frames — see `createUserStylesheetCssMemo`. */
export const buildUserStylesheetCss: UserStylesheetCssBuilder = createUserStylesheetCssMemo()
