/**
 * UserStylesheetInjector — injects user-authored CSS files (from
 * `site.files[type === 'style']`) into a target document.
 *
 * Multi-document support
 * ──────────────────────
 * Each breakpoint frame in the canvas is its own iframe. `IframeFrameSurface`
 * mounts one of these injectors per frame, targeting the iframe's document
 * so user CSS lands inside the page document — exactly where it sits on the
 * published site. When no `targetDocument` prop is passed, the injector
 * falls back to the editor's main document (currently only used by tests
 * and any non-iframe canvas path).
 *
 * The CSS goes in unchanged. Inside the iframe the `<body>` IS the page
 * body, `body > nav` is a real direct-child relationship, and `:nth-child()`
 * counts the authored elements — no rewriting needed. This is the whole
 * point of the iframe-per-frame architecture (see
 * `docs/features/canvas-iframe-per-frame.md`).
 *
 * The injected CSS is produced by `collectUserStylesheetCss` (the same helper
 * the publisher uses) scoped to the active page, so each iframe loads the
 * exact bytes the published page receives — same stylesheet selection (scope
 * + enable state), same cascade order (priority, then path), same comment
 * wrapping.
 *
 * WS-10 Phase 1 — `prefers-color-scheme` rewrite
 * ────────────────────────────────────────────────
 * Applied unconditionally (a no-op when the CSS has no such media query — see
 * `darkSchemeCssTransform.ts`'s cheap short-circuit): a project whose dark
 * mode is expressed via a media query gets it rewritten into an attribute
 * selector Studio's own preview-axes toggle controls, on this injected copy
 * only. The file on disk is never touched.
 *
 * Perf (Track C3)
 * ────────────────
 * This used to subscribe to the WHOLE `s.site` object and run
 * `collectUserStylesheetCss` → `resolveViewportUnitsForCanvas` (regex) →
 * `rewritePrefersColorScheme` (regex) directly in the render body. `site`'s
 * top-level reference changes on every site-touching mutation anywhere in the
 * document, so that chain re-ran on every keystroke, in every mounted iframe.
 * Now it follows `ClassStyleInjector.tsx`'s pattern: narrow selectors + an
 * effect-gated recompute. The CSS only depends on `site.files`, `site.runtime`
 * (both selected directly — their references are structurally-shared-stable
 * across edits to node content, since Mutative only recreates the branch of
 * the tree actually touched), and — for per-page scope matching — the active
 * page's `id` and whether it carries a template (`RuntimeScopedPage`, see
 * `userStylesheets.ts`). The active page's NODE CONTENT is irrelevant to scope
 * matching, so this selector uses `useShallow` over just those two primitive
 * fields rather than the page object itself, meaning even typing inside the
 * active page's own content does not recompute this stylesheet.
 */

import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SiteFile } from '@core/files/schemas'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { collectUserStylesheetCss } from '@core/publisher'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from './canvasCssLayers'
import { rewritePrefersColorScheme } from './darkSchemeCssTransform'

const STYLE_TAG_ID = 'mc-user-styles'

/** Stable empty fallback for the files selector (Guideline #239). */
const EMPTY_FILES: SiteFile[] = []

interface UserStylesheetInjectorProps {
  /**
   * Document to inject the <style> tag into. Defaults to the editor's main
   * document.
   */
  targetDocument?: Document
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) to fixed
   * px so they don't feed the iframe's grow-to-content height loop. When
   * omitted (non-iframe contexts), CSS is injected verbatim. See
   * `resolveViewportUnits.ts`.
   */
  viewport?: CanvasViewport
}

export function UserStylesheetInjector({ targetDocument, viewport }: UserStylesheetInjectorProps = {}) {
  // Narrow slices — see the module doc's "Perf (Track C3)" section. None of
  // these mint a fresh reference on an edit to node content anywhere on the
  // board (Mutative's structural sharing keeps `site.files`/`site.runtime`
  // stable across unrelated mutations); `activePageScope` is additionally
  // shallow-compared so only its two primitive fields matter, not the active
  // page's own node content.
  const files = useEditorStore((s) => s.site?.files ?? EMPTY_FILES)
  const runtime = useEditorStore((s) => s.site?.runtime ?? null)
  const activePageScope = useEditorStore(
    useShallow((s) => {
      // `selectActiveCanvasPage`, not a raw `s.site?.pages.find(...)` — the
      // frame this injector is mounted into (`IframeFrameSurface`) renders
      // whatever `selectActiveCanvasPage` resolves (see `CanvasRoot.tsx`'s
      // `canvasPage`), which in VC edit mode is a *virtual* Page synthesized
      // from the VC's tree, not a member of `site.pages`. `s.activePageId` is
      // deliberately NOT cleared on entering VC mode (see `uiSlice.ts`), so a
      // raw `pages.find` on it silently resolved the real page the author was
      // on *before* opening the VC — scoping "this page only" user
      // stylesheets to the wrong document and never matching stylesheets
      // scoped to the VC itself.
      const page = selectActiveCanvasPage(s)
      // Only `id` and template PRESENCE feed `assetScopeAppliesToPage` — see
      // `RuntimeScopedPage`. Collapsing `template` to a boolean (rather than
      // passing the sub-object through) keeps this shallow-comparable AND
      // correct: the two shapes (`unknown` vs `boolean`) are equivalent under
      // `Boolean(...)`, the only operation `assetScopeAppliesToPage` performs
      // on it.
      return page ? { id: page.id, template: Boolean(page.template) } : null
    }),
  )

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    let styleEl = targetDoc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDoc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'UserStylesheetInjector')
      targetDoc.head.appendChild(styleEl)
    }

    // Concatenate the user stylesheets that target the active page, in
    // cascade order. Delegates to `collectUserStylesheetCss` so the canvas
    // loads the exact bytes the published page receives — scope, priority,
    // and enable state all honoured. Viewport units are then pinned to the
    // frame viewport (canvas-only) so authored `vh`/`vmax`/… can't make the
    // grow-to-content iframe height explode.
    //
    // The reactive deps above (`files`, `runtime`, `activePageScope`) decide
    // WHEN this recomputes; `site` itself is re-read fresh here (not
    // subscribed) purely to hand `collectUserStylesheetCss` its full
    // `SiteDocument` — that read does not add its own reactivity.
    const site = useEditorStore.getState().site
    const collected = site && activePageScope
      ? collectUserStylesheetCss(site, activePageScope)
      : ''
    const viewportResolved = viewport ? resolveViewportUnitsForCanvas(collected, viewport) : collected
    const css = rewritePrefersColorScheme(viewportResolved)

    // Wrap in a named cascade layer so editor-chrome CSS (unlayered, from
    // EditorChromeInjector) always wins over user-authored stylesheets regardless
    // of specificity. User styles still cascade among themselves normally inside
    // the layer (source order + specificity preserved). The
    // `CANVAS_CSS_LAYER_ORDER` prelude also pins this layer ABOVE `@layer vendor`
    // (`ProjectCssInjector`, WS-2.3) — see `canvasCssLayers.ts`.
    styleEl.textContent = css
      ? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${css}\n}`
      : `${CANVAS_CSS_LAYER_ORDER}\n/* no user stylesheets */`
  }, [targetDocument, viewport, files, runtime, activePageScope])

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
