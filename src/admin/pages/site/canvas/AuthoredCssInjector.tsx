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
 * user-authored`) — this applies that same, already-working mechanism to a
 * new CSS source, not a new mechanism.
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
 * `mc-authored` is always inserted BEFORE `mc-classes` in DOM source order
 * (see the effect below) — both share `@layer user-authored`, and cascade
 * order inside a layer is source order, so a session-edited overlay rule for
 * the SAME selector still wins over this raw, on-disk value.
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

import { useEffect, useSyncExternalStore } from 'react'
import { getStudioAuthoredCss, subscribeStudioAuthoredCss } from '@site/studio/fsCodemodAdapter'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from './canvasCssLayers'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'

const STYLE_TAG_ID = 'mc-authored'

interface AuthoredCssInjectorProps {
  /** Document to inject the <style> tag into. Defaults to the editor's main document. */
  targetDocument?: Document
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) to fixed
   * px so they don't feed the iframe's grow-to-content height loop. When
   * omitted, CSS is injected verbatim. See `resolveViewportUnits.ts`.
   */
  viewport?: CanvasViewport
}

export function AuthoredCssInjector({ targetDocument, viewport }: AuthoredCssInjectorProps = {}) {
  const authoredCss = useSyncExternalStore(subscribeStudioAuthoredCss, getStudioAuthoredCss, getStudioAuthoredCss)

  useEffect(() => {
    const doc = targetDocument ?? document
    let styleEl = doc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = doc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'AuthoredCssInjector')
      // Prepend — same pattern `ProjectCssInjector` uses — so this
      // stylesheet is read BEFORE `mc-classes` (`ClassStyleInjector`)
      // regardless of which component's mount effect happens to run first.
      // Both share `@layer user-authored`; cascade priority inside one
      // layer is source order, so this ordering is what lets a session-
      // edited overlay rule win over this injector's raw, on-disk value for
      // the same selector — see this module's "Raw vs. overlay" doc.
      doc.head.insertBefore(styleEl, doc.head.firstChild)
    }
    const viewportResolved = viewport ? resolveViewportUnitsForCanvas(authoredCss, viewport) : authoredCss
    const css = rewritePrefersColorScheme(viewportResolved)
    styleEl.textContent = css
      ? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${css}\n}`
      : `${CANVAS_CSS_LAYER_ORDER}\n/* no authored css */`

    return () => {
      doc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument, viewport, authoredCss])

  return null
}
