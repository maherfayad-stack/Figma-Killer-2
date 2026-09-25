/**
 * AuthoredCssInjector — injects a project's own `.css` (and WS-2.1's
 * compiled Tailwind/Sass/PostCSS/CSS-Modules output) into a canvas iframe's
 * `<head>` as RAW TEXT, byte-faithful to what a real browser would render.
 *
 * ## Why this exists (board-27)
 *
 * The canvas used to render a project's own CSS exclusively through
 * `ClassStyleInjector`'s `<style id="mc-classes">` — CSS text REGENERATED
 * from the `site.styleRules` registry, which `server/handlers/studioCss.ts`
 * builds by parsing every stylesheet through happy-dom's CSSOM
 * (`cssToStyleRules`). happy-dom silently DROPS any declaration it cannot
 * parse — measured: `color-mix()`, `Canvas`/`CanvasText` system colours, and
 * slash-alpha `rgb(0 0 0 / .2)` all vanish with no warning anywhere. The
 * canvas therefore rendered the user's own CSS differently than a real
 * browser/build would, silently.
 *
 * This injector is the fix: it renders `authoredCss`
 * (`server/handlers/studioCss.ts`'s `StudioStyles.authoredCss` — every
 * stylesheet's RAW text, `extraCss` first then each `.css` file, in cascade
 * order) completely unparsed. `UserStylesheetInjector.tsx` already proves the
 * exact pattern needed for hand-authored CMS stylesheets (raw CSS string →
 * `resolveViewportUnitsForCanvas` → `rewritePrefersColorScheme` → `@layer
 * user-authored`, now one call: `canvasFrameCss`, which also resolves the
 * project's site-root `url()`s, P5-B2) — this applies that same,
 * already-working mechanism to a new CSS source, not a new mechanism.
 *
 * `ProjectCssInjector`'s vendor CSS is exempt from this bug entirely — it is
 * injected raw as `mc-vendor` and never round-trips through the CSSOM at
 * all. That is the proof this fix works: the same "inject raw, skip the
 * lossy parse" treatment, applied to the project's OWN CSS instead of its
 * dependencies'.
 *
 * ## Raw vs. overlay — the two are reconciled, not duplicated
 *
 * This injector renders "what is on disk" — a static snapshot from the last
 * load. `ClassStyleInjector`'s `mc-classes` still exists and still
 * regenerates from `site.styleRules`, but as of `canvasClassCss.ts`'s
 * `styleRuleNeedsCanvasOverlay`, it now renders ONLY editor-authored rules
 * and imported rules a session edit has actually touched (`updatedAt > 0`)
 * — "what has changed and is not yet confirmed back on disk". An unedited
 * imported rule is left to render from THIS injector alone, so its CSSOM-
 * lossy registry entry is never emitted at all.
 *
 * `mc-authored` must always precede `mc-classes` in DOM source order — both
 * share `@layer user-authored`, and cascade order inside a layer is source
 * order, so a session-edited overlay rule for the SAME selector still wins
 * over this raw, on-disk value. Since `live-05` (STATE.md), both are managed
 * through `adapter.applyOverlay`, whose first-call-wins insertion order is
 * fixed by `IframeFrameSurface.tsx`'s JSX order (this component before
 * `ClassStyleInjector`) — see that file's comment at the call site. Do not
 * reorder those two without re-checking this invariant.
 *
 * ## Known gap — deleting an imported ambient rule
 *
 * Deleting an imported, `kind: 'ambient'` `StyleRule` removes it from
 * `site.styleRules`, but its selector's declarations are still sitting in
 * this injector's raw text (a snapshot from load time) — the overlay can no
 * longer suppress it, because the rule object it would key off of is gone.
 * The rule reappears correctly on the next reload (a fresh `authoredCss`
 * snapshot). Not fixed by this injector — named here as a documented,
 * narrow follow-up, not silently swallowed.
 */

import { useContext, useEffect, useSyncExternalStore } from 'react'
import { getStudioAuthoredCss, subscribeStudioAuthoredCss } from '@site/studio/fsCodemodAdapter'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import type { CanvasViewport } from './resolveViewportUnits'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from './canvasCssLayers'
import { canvasFrameCss } from './canvasFrameCss'

const STYLE_TAG_ID = 'mc-authored'

interface AuthoredCssInjectorProps {
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) to fixed
   * px so they don't feed the iframe's grow-to-content height loop. When
   * omitted, CSS is injected verbatim. See `resolveViewportUnits.ts`.
   */
  viewport?: CanvasViewport
}

export function AuthoredCssInjector({ viewport }: AuthoredCssInjectorProps = {}) {
  const authoredCss = useSyncExternalStore(subscribeStudioAuthoredCss, getStudioAuthoredCss, getStudioAuthoredCss)
  const adapter = useContext(CanvasFrameAdapterContext)

  useEffect(() => {
    if (!adapter) return
    const css = canvasFrameCss(authoredCss, viewport)
    adapter.applyOverlay(
      STYLE_TAG_ID,
      css
        ? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${css}\n}`
        : `${CANVAS_CSS_LAYER_ORDER}\n/* no authored css */`,
    )
  }, [adapter, viewport, authoredCss])

  useEffect(() => {
    return () => adapter?.removeOverlay(STYLE_TAG_ID)
  }, [adapter])

  return null
}
