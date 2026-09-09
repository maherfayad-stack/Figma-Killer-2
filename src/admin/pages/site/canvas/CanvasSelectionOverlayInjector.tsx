/**
 * CanvasSelectionOverlayInjector — the in-iframe half of the selection
 * overlay (STUDIO-IMPORT-V2-PLAN.md WS-5.1).
 *
 * Why this exists
 * ────────────────
 * Selection/hover rings and the toolbar/inspector used to live entirely in
 * the PARENT document, positioned from measurements taken inside a zoomed,
 * panned iframe: `elementRect × zoom + iframeOffset + panOffset`, recomputed
 * on every tick. Any staleness in any term showed up as displacement, and at
 * zoom ≠ 1 the error was multiplied — the "selection ring / props panel
 * lands far from the element" defect (`STATE.md` `standing-03`).
 *
 * The fix: render the rings and the node-name badge INSIDE the iframe
 * document, in the SAME coordinate space as the element they track. No
 * conversion, no zoom multiplication, no drift — panning/zooming the canvas
 * moves the iframe element (and everything painted inside it, including this
 * overlay) as one composited CSS transform, at zero extra per-frame cost.
 * `InPlaceInspector` and the selection toolbar stay in the parent document
 * (real inputs/buttons inside a transformed iframe are a worse problem) —
 * see `BreakpointSelectionOverlay`'s `--selection-anchor-*` channel for how
 * they stay anchored without re-introducing the per-tick zoom math.
 *
 * Two responsibilities, mirroring the other per-frame injectors
 * (`EditorChromeInjector`, `CanvasAnimationInjector`, …):
 *
 *   1. An UNLAYERED stylesheet in `<head>` — ring/badge CSS keyed to stable
 *      `data-*` attributes, because CSS Module classes don't exist inside the
 *      iframe (see `EditorChromeInjector`'s docblock). Unlayered so it beats
 *      both `@layer vendor` and `@layer user-authored` regardless of author
 *      specificity — selection chrome must never be invisible behind a `*`
 *      rule some vendor stylesheet ships.
 *   2. A single overlay ROOT div appended to `<body>` — `position: absolute;
 *      top: 0; left: 0; width: 0; height: 0; overflow: visible`. Zero-size on
 *      purpose: `iframeBodyReset.ts` documents a real feedback loop where an
 *      `inset: 0` overlay's own size feeds back into `body.scrollHeight`,
 *      which feeds the grow-to-content measurement, forever. This root never
 *      does that — its own box never exceeds 0×0, and its children (rings,
 *      badge) are positioned with `transform: translate()`, which — unlike
 *      top/left — is purely visual and never contributes to a containing
 *      block's scrollable overflow, however far outside the 0×0 box it moves
 *      them.
 *
 * `BreakpointSelectionOverlay` (parent-doc component, still the sole owner of
 * selection STATE) portals its ring/badge elements into the root this
 * component reports via `onRootReady`.
 *
 * Design-mode only. `IframeFrameSurface` mounts this only when `!isLive` —
 * the same gate as `CanvasAnimationInjector` / `CanvasScrollUnrollInjector` —
 * so live/published pages never see it and it never reaches the publisher.
 * It carries no `data-node-id`, so it can never become a selectable/hoverable
 * canvas node and never appears in the DOM panel (which is state-driven, not
 * a raw-DOM walk). It needs no explicit exclusion from
 * `applyIframeBodyPresentation`'s ownership — that helper only ever touches
 * `body`'s OWN className/style/attributes, never `body`'s children, so
 * appending this sibling node is invisible to it by construction.
 */
import { useEffect } from 'react'
import {
  SELECTION_OVERLAY_ROOT_ID,
  SELECTION_STYLE_TAG_ID,
  buildSelectionChromeStylesheet,
} from '@core/studio-runtime'

interface CanvasSelectionOverlayInjectorProps {
  /** The iframe document to inject the overlay stylesheet + root into. */
  targetDocument: Document
  /** The parent (editor) document to read ring/badge tokens from. */
  parentDocument: Document
  /**
   * Called with the overlay root element once it exists (mount, or a
   * document swap), and with `null` on cleanup (unmount, or before the next
   * document's root replaces it).
   */
  onRootReady: (root: HTMLDivElement | null) => void
}

export function CanvasSelectionOverlayInjector({
  targetDocument,
  parentDocument,
  onRootReady,
}: CanvasSelectionOverlayInjectorProps) {
  // Stylesheet: ring/badge appearance + forwarded tokens.
  useEffect(() => {
    let styleEl = targetDocument.getElementById(SELECTION_STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDocument.createElement('style')
      styleEl.id = SELECTION_STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'CanvasSelectionOverlayInjector')
      targetDocument.head.appendChild(styleEl)
    }
    styleEl.textContent = buildSelectionChromeStylesheet(parentDocument)
  }, [targetDocument, parentDocument])

  useEffect(() => {
    const targetDoc = targetDocument
    return () => {
      targetDoc.getElementById(SELECTION_STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  // Overlay root: a zero-size, out-of-flow div appended to <body>. See the
  // module docblock for why zero-size is load-bearing.
  useEffect(() => {
    if (!targetDocument.body) return
    let root = targetDocument.getElementById(SELECTION_OVERLAY_ROOT_ID) as HTMLDivElement | null
    if (!root) {
      root = targetDocument.createElement('div')
      root.id = SELECTION_OVERLAY_ROOT_ID
      root.setAttribute('data-studio-canvas-overlay-root', 'true')
      Object.assign(root.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '0',
        height: '0',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: '2147483647',
      })
      targetDocument.body.appendChild(root)
    }
    onRootReady(root)
    return () => {
      root?.remove()
      onRootReady(null)
    }
  }, [targetDocument, onRootReady])

  return null
}
