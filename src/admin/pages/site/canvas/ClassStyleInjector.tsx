/**
 * ClassStyleInjector — injects/updates user class CSS into the target
 * document whenever the site's class registry changes.
 *
 * This is a pure side-effect component (renders null). It subscribes to
 * `site.styleRules` via a stable selector and imperatively manages a single
 * <style id="mc-classes"> element in the target document's <head>.
 *
 * Multi-document support
 * ──────────────────────
 * Each breakpoint frame in the canvas is its own iframe, with its own
 * document. `IframeFrameSurface` mounts one of these injectors per frame;
 * this component reads the frame's `FrameDocumentAdapter` from
 * `CanvasFrameAdapterContext` rather than a `Document` prop, so it works
 * unchanged whether the frame's DOM is a same-origin portal or a future
 * cross-origin bridge (`live-05`, STATE.md). A `null` adapter (no context
 * provider above this component) is a no-op.
 *
 * Architecture:
 * - One <style> tag per target document, kept in sync on every class
 *   registry change.
 * - CSS is generated from CSSPropertyBag by camelCase → kebab-case conversion.
 * - @media / `[data-breakpoint-id]` blocks are emitted for breakpoint overrides
 *   (uses site.breakpoints).
 * - No FOUC: the style element is created synchronously before first paint.
 *
 * Security (Constraint #228):
 * - Property names are validated against an allowlist (camelCase CSS properties).
 * - Values are sanitised via the canonical sanitiseCssValue() from publisher/utils.
 * - Only known CSS property names from CSSPropertyBag interface are emitted.
 *
 * Performance:
 * - Subscribes with granular selectors so re-renders only happen when the
 *   relevant slices actually change (not on every site edit).
 * - `generateCanvasClassCSS` is identity-memoized on its 8 inputs (see
 *   `createCanvasClassCssMemo`). All breakpoint-frame injectors render with
 *   the same store snapshot in the same commit, so the full registry CSS is
 *   generated ONCE per change and frames 2..N reuse the cached string. Only
 *   the per-frame viewport-unit resolution still runs per injector — its
 *   output genuinely differs per frame width.
 *
 * WS-10 Phase 1 — `prefers-color-scheme` rewrite
 * ────────────────────────────────────────────────
 * An imported project's OWN `@media (prefers-color-scheme: dark)` block (from
 * its own `.css`, parsed by `cssToStyleRules.ts`'s "unmatched @media" path
 * into a `ConditionDef`) — and the SAME condition a user can author by hand
 * via `ConditionBuilder.tsx`'s "Dark mode" preset — both re-emit through this
 * SAME `generateCanvasClassCSS`/`createStyleRuleCssEmitter` engine, which is
 * ALSO what the publisher's `generateClassCSS` calls to build the real
 * published stylesheet. All three CSS strings this injector produces (the
 * main registry, the hover-preview overlay, the forced-state overlay) are
 * therefore piped through `rewritePrefersColorScheme` (with the rest of
 * `canvasFrameCss`'s canvas-only transforms) on the way into the
 * `<style>` tag — CANVAS-SIDE ONLY, after generation, never inside
 * `generateClassCSS`/`createStyleRuleCssEmitter` itself. `@core/publisher` is
 * not touched: a real browser DOES support `prefers-color-scheme` correctly
 * per visitor, so the published page must keep emitting the genuine `@media`
 * query — the rewrite exists purely because the canvas cannot emulate that
 * media feature per-iframe. See `darkSchemeCssTransform.ts`'s own doc for the
 * mechanism, and `styleRuleDarkModeRoundTrip.test.ts` for the test that
 * proves the two paths diverge exactly as intended (canvas rewrites, publish
 * doesn't).
 */

import { use, useContext, useEffect } from 'react'
import { useEditorStore, type EditorStore } from '@site/store/store'
import { styleRuleSelector, type ConditionDef, type StyleRule } from '@core/page-tree'
import { collectBackgroundImagePaths } from '@core/publisher'
import { useResponsiveEditorMediaAssets } from '@admin/shared/media/hooks/useResponsiveBackgroundStyle'
import { selectorStatePseudo } from '@site/cssStatePseudo'
import { CanvasFrameAdapterContext, CanvasFrameContext, CanvasPageContext } from './CanvasContexts'
import { framePageCanRender } from './useBreakpointOverlaySelectionState'
import { registryBackgroundImagePaths } from './canvasBackgroundImagePaths'
import { generateCanvasClassCSS, generateForcedStateCSS, generatePreviewClassCSS } from './canvasClassCss'
import type { CanvasViewport } from './resolveViewportUnits'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from './canvasCssLayers'
import { canvasFrameCss } from './canvasFrameCss'

interface ClassStyleInjectorProps {
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) in class
   * styles to fixed px so they don't feed the iframe's grow-to-content height
   * loop. When omitted (non-iframe contexts), CSS is injected verbatim. See
   * `resolveViewportUnits.ts`.
   */
  viewport?: CanvasViewport
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = 'mc-classes'
const PREVIEW_STYLE_TAG_ID = 'mc-classes-preview'
const FORCE_STATE_STYLE_TAG_ID = 'mc-classes-force-state'

/**
 * Stable empty array used as the ?? fallback for breakpoints selector.
 * Must be module-scope so it's reference-stable across renders — an inline `?? []`
 * literal creates a new array instance on every call, forcing unnecessary re-renders
 * (Guideline #239 — Zustand selectors must not use inline ?? [] / ?? {} fallbacks).
 */
const EMPTY_BREAKPOINTS: Array<{ id: string; width: number }> = []

/** Stable empty fallback for the conditions selector (Guideline #239). */
const EMPTY_CONDITIONS: ConditionDef[] = []

/**
 * Stable empty registry passed to `generateCanvasClassCSS` when the site has
 * no style rules. An inline `{}` literal would mint a new identity per effect
 * run, defeating the generator's input-identity memo across frames.
 */
const EMPTY_STYLE_RULES: Record<string, StyleRule> = {}

export function ClassStyleInjector({ viewport }: ClassStyleInjectorProps = {}) {
  const adapter = useContext(CanvasFrameAdapterContext)
  // Subscribe to class registry — shallow equality so we only re-run when
  // the classes object reference changes (Mutative always creates a new ref on mutation)
  const classes = useEditorStore((s) => s.site?.styleRules ?? null)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const conditions = useEditorStore((s) => s.site?.conditions ?? EMPTY_CONDITIONS)
  const frameworkColors = useEditorStore((s) => s.site?.settings.framework?.colors ?? null)
  const frameworkTypography = useEditorStore((s) => s.site?.settings.framework?.typography ?? null)
  const frameworkSpacing = useEditorStore((s) => s.site?.settings.framework?.spacing ?? null)
  const frameworkPreferences = useEditorStore((s) => s.site?.settings.framework?.preferences ?? null)
  const fonts = useEditorStore((s) => s.site?.settings.fonts ?? null)
  const previewClassStyles = useEditorStore((s) => s.previewClassStyles)
  const backgroundPaths = [
    ...registryBackgroundImagePaths(classes ?? EMPTY_STYLE_RULES),
    ...collectBackgroundImagePaths(previewClassStyles?.styles.backgroundImage),
  ]
  const {
    mediaAssets: responsiveMediaAssets,
    signature: responsiveMediaSignature,
  } = useResponsiveEditorMediaAssets(backgroundPaths)

  useEffect(() => {
    if (!adapter) return

    const generated = generateCanvasClassCSS(
      classes ?? EMPTY_STYLE_RULES,
      breakpoints,
      conditions,
      frameworkColors,
      frameworkTypography,
      frameworkSpacing,
      frameworkPreferences,
      fonts,
      { mediaAssets: responsiveMediaAssets, mediaSignature: responsiveMediaSignature },
    )
    // Editor-chrome CSS stays unlayered (`EditorChromeInjector`) and so beats
    // every named layer regardless of specificity. The `CANVAS_CSS_LAYER_ORDER`
    // prelude pins `reset` below `vendor` below `user-authored` no matter which
    // stylesheet's rule body the browser encounters first — see
    // `canvasCssLayers.ts`. The `reset` layer itself is never populated here:
    // a Studio-parsed page IS a real React project's own `.tsx`, and "the
    // repository is the document" means the project's own CSS (or the
    // complete absence of one) is the whole truth. Injecting a modern reset
    // would make every element the project hasn't styled — a bare `<ul>`, an
    // unclassed heading, a table, a link — look BETTER than what a real
    // browser renders, which is exactly the "did I actually style this" case
    // a user is most likely to be checking.
    // Canvas-only: project asset URLs, viewport units pinned to the frame (so
    // `vh` can't feed the grow-to-content height loop), previewed scheme.
    const css = canvasFrameCss(generated, viewport)
    adapter.applyOverlay(
      STYLE_TAG_ID,
      css
        ? `${CANVAS_CSS_LAYER_ORDER}\n@layer ${USER_AUTHORED_LAYER} {\n${css}\n}`
        : `${CANVAS_CSS_LAYER_ORDER}\n/* no classes */`,
    )
  }, [
    adapter,
    viewport,
    classes,
    breakpoints,
    conditions,
    frameworkColors,
    frameworkTypography,
    frameworkSpacing,
    frameworkPreferences,
    fonts,
    responsiveMediaAssets,
    responsiveMediaSignature,
  ])

  // Preview overlay — a higher-specificity rule emitted while a user is
  // hovering a suggestion in a property control (e.g. spacing token
  // dropdown). Lives in its own <style> tag so it can be toggled cleanly
  // without re-running the main class-CSS generation.
  useEffect(() => {
    if (!adapter) return
    if (!previewClassStyles) {
      adapter.applyOverlay(PREVIEW_STYLE_TAG_ID, '')
      return
    }
    const cls = classes?.[previewClassStyles.classId]
    // State-pseudo rules are handled by the forced-state preview below — their
    // real `:hover`-style selector would never match here anyway.
    if (!cls || (cls.kind === 'ambient' && selectorStatePseudo(styleRuleSelector(cls)) !== null)) {
      adapter.applyOverlay(PREVIEW_STYLE_TAG_ID, '')
      return
    }
    const previewCss = generatePreviewClassCSS(cls, {
      breakpointId: previewClassStyles.breakpointId ?? null,
      styles: previewClassStyles.styles,
    }, { mediaAssets: responsiveMediaAssets })
    const resolvedPreviewCss = canvasFrameCss(previewCss, viewport)
    // Keep in the same @layer so the doubled-selector preview rule still wins
    // over the regular class rule within the layer (higher specificity). No
    // need to repeat CANVAS_CSS_LAYER_ORDER here — the main effect above
    // always runs first (same component, earlier useEffect) and already
    // declares it.
    adapter.applyOverlay(
      PREVIEW_STYLE_TAG_ID,
      resolvedPreviewCss ? `@layer ${USER_AUTHORED_LAYER} {\n${resolvedPreviewCss}\n}` : '',
    )
  }, [adapter, viewport, classes, previewClassStyles, responsiveMediaAssets])

  // Cleanup: remove the overlays when the component unmounts or the adapter
  // instance changes (a fresh frame document).
  useEffect(() => {
    return () => {
      adapter?.removeOverlay(STYLE_TAG_ID)
      adapter?.removeOverlay(PREVIEW_STYLE_TAG_ID)
    }
  }, [adapter])

  return <ForcedStatePreviewStyle viewport={viewport} mediaAssets={responsiveMediaAssets} />
}

/**
 * The selected node's id when THIS frame renders it, else `null` — the same
 * scoping the selection rings use (`useBreakpointOverlaySelectionState`): a
 * board frame answers for the selection it originated, and a frame whose page
 * does not contain the node answers `null`, so a click elsewhere on the board
 * changes nothing here.
 */
function selectedNodeRenderedHere(s: EditorStore, frameId: string | null, framePageId: string | null): string | null {
  const id = s.selectedNodeId
  if (!id) return null
  if (s.selectedNodeFrameId !== null) return s.selectedNodeFrameId === frameId ? id : null
  return framePageCanRender(s._nodeIdToPageIds, id, framePageId) ? id : null
}

/**
 * The forced-state preview, in its own component so that the class-CSS
 * generator above does not re-render on every click. It is the only part of
 * this injector that depends on the selection, and it used to be an effect of
 * the injector itself — which every mounted frame runs — so each click
 * re-rendered all of them and re-wrote an empty `<style>` in each (P6-C).
 */
function ForcedStatePreviewStyle({
  viewport,
  mediaAssets,
}: {
  viewport: CanvasViewport | undefined
  mediaAssets: ReturnType<typeof useResponsiveEditorMediaAssets>['mediaAssets']
}) {
  const adapter = useContext(CanvasFrameAdapterContext)
  const frameId = use(CanvasFrameContext)
  const framePageId = use(CanvasPageContext)
  const selectedNodeId = useEditorStore((s) => selectedNodeRenderedHere(s, frameId, framePageId))
  const activeClassId = useEditorStore((s) => (selectedNodeRenderedHere(s, frameId, framePageId) ? s.activeClassId : null))
  const classes = useEditorStore((s) => s.site?.styleRules ?? null)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const conditions = useEditorStore((s) => s.site?.conditions ?? EMPTY_CONDITIONS)
  const previewClassStyles = useEditorStore((s) => s.previewClassStyles)
  const responsiveMediaAssets = mediaAssets

  // Forced state preview — when a state-pseudo selector (`.btn:hover`, …) is the
  // active selector, paint its declarations onto the selected node so the state
  // is visible/editable without physically triggering it (you can't toggle
  // `:hover` via the DOM). Plain classes are edited in place and need no force;
  // non-state ambients already match directly. In-flight edits to the same rule
  // are overlaid so dragging a control updates the preview live.
  useEffect(() => {
    if (!adapter) return
    const rule = activeClassId ? classes?.[activeClassId] : null
    const isStateRule = !!rule && rule.kind === 'ambient' && selectorStatePseudo(styleRuleSelector(rule)) !== null

    if (!rule || !isStateRule || !selectedNodeId) {
      adapter.applyOverlay(FORCE_STATE_STYLE_TAG_ID, '')
      return
    }

    // Overlay an in-flight edit to the same rule into the context it targets so
    // dragging a control updates the forced preview live, at the right breakpoint.
    const inflight = previewClassStyles?.classId === activeClassId
      ? { contextId: previewClassStyles.breakpointId ?? null, styles: previewClassStyles.styles }
      : null
    const forcedCss = generateForcedStateCSS(
      selectedNodeId,
      rule,
      breakpoints,
      conditions,
      inflight,
      { mediaAssets: responsiveMediaAssets },
    )
    const resolved = canvasFrameCss(forcedCss, viewport)
    adapter.applyOverlay(FORCE_STATE_STYLE_TAG_ID, resolved ? `@layer ${USER_AUTHORED_LAYER} {\n${resolved}\n}` : '')
  }, [
    adapter,
    viewport,
    classes,
    breakpoints,
    conditions,
    activeClassId,
    selectedNodeId,
    previewClassStyles,
    responsiveMediaAssets,
  ])

  useEffect(() => {
    return () => {
      adapter?.removeOverlay(FORCE_STATE_STYLE_TAG_ID)
    }
  }, [adapter])

  return null
}
