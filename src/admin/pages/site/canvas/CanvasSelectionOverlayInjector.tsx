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

const STYLE_TAG_ID = 'studio-canvas-selection-chrome'
const OVERLAY_ROOT_ID = 'studio-canvas-selection-overlay-root'

/** Tokens the ring/badge CSS below reads, forwarded from the parent :root. */
const SELECTION_CHROME_TOKENS = [
  '--canvas-selection-ring',
  '--canvas-hover-ring',
  '--canvas-selector-ring',
  '--canvas-selection-ring-color',
  '--canvas-node-badge-text',
  '--canvas-resize-handle-fill',
] as const

/**
 * Module-scope so the React Compiler doesn't flag the `getComputedStyle` call
 * as a side-effect inside a component body (mirrors `EditorChromeInjector`).
 */
function buildTokenBlock(parentDoc: Document): string {
  const parentStyles = getComputedStyle(parentDoc.documentElement)
  const declarations = SELECTION_CHROME_TOKENS.flatMap((token) => {
    const value = parentStyles.getPropertyValue(token).trim()
    return value ? [`  ${token}: ${value};`] : []
  })
  if (declarations.length === 0) return ''
  return `:root {\n${declarations.join('\n')}\n}`
}

/**
 * Ring/badge appearance rules, targeting the stable `data-*` hooks
 * `BreakpointSelectionOverlay` sets on the elements it portals into the
 * overlay root. Position (`transform`, `width`, `height`) is written
 * imperatively per element by `canvasSelectionOverlayPositioning.ts` — this
 * stylesheet owns appearance only. NO default `display: none` here:
 * `positionOverlayElement`/`positionNodeBadge`'s "show" path is
 * `element.style.display = ''` (clear the inline override), which falls
 * back to whatever THIS stylesheet declares — a `display: none` base rule
 * here would make that fallback permanently hidden instead of visible.
 * `hideOverlayElement`/`positionNodeBadge`'s "hide" path sets the inline
 * `display: none` explicitly, so a freshly-mounted (unpositioned) element is
 * a plain empty box until the next RAF tick sizes and positions it —
 * functionally invisible either way, but through inline styles only, never
 * through this stylesheet's default.
 *
 * Module-scope constant: stable across renders, never captured into a
 * closure.
 */
const SELECTION_CHROME_RULES = `
[data-canvas-selection-ring],
[data-canvas-hover-ring],
[data-canvas-selector-highlight-ring] {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  border-radius: 1px;
  pointer-events: none;
}

[data-canvas-selection-ring] {
  box-shadow: var(--canvas-selection-ring);
}

[data-canvas-hover-ring] {
  box-shadow: var(--canvas-hover-ring);
}

[data-canvas-selector-highlight-ring] {
  box-shadow: var(--canvas-selector-ring);
}

[data-canvas-node-badge] {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--canvas-selection-ring-color);
  color: var(--canvas-node-badge-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
}

/* Resize handles (elements, not frames). The FRAME tracks the element's box
   exactly like a ring does and stays click-through; only the handles inside
   it take pointer events, so selecting and dragging content underneath the
   element is unaffected everywhere except within a few px of its edges.

   The cursor declarations carry !important - the ONLY ones here that do.
   iframeBodyReset.ts injects a universal "cursor: default !important" to
   neutralize the USER'S page affordances inside a design frame, and an
   !important on the universal selector cannot be beaten by specificity alone.
   These handles are editor chrome, not the user's page, and a handle that does
   not say which way it drags is the difference between an affordance and a
   guess. Same carve-out [contenteditable] already gets there for the text
   caret, and for the same reason. Everything else in this block stays
   unprefixed.

   (No backticks anywhere in this comment: the whole block is a template
   literal, and one would end the string.) */
[data-canvas-resize-frame] {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  pointer-events: none;
}

[data-canvas-resize-handle] {
  position: absolute;
  box-sizing: border-box;
  width: 9px;
  height: 9px;
  margin: -5px 0 0 -5px;
  border: 1px solid var(--canvas-selection-ring-color);
  border-radius: 2px;
  background: var(--canvas-resize-handle-fill);
  pointer-events: auto;
  touch-action: none;
}

[data-canvas-resize-handle="nw"] { top: 0;    left: 0;    cursor: nwse-resize !important; }
[data-canvas-resize-handle="ne"] { top: 0;    left: 100%; cursor: nesw-resize !important; }
[data-canvas-resize-handle="se"] { top: 100%; left: 100%; cursor: nwse-resize !important; }
[data-canvas-resize-handle="sw"] { top: 100%; left: 0;    cursor: nesw-resize !important; }

/* Edges are invisible STRIPS along the whole side, not dots at its midpoint:
   the ask was "drag the sides", and a 9px target in the middle of a 300px
   edge is a worse version of the same gesture. The corner squares above are
   the only visible handles, which also keeps a small element from being
   buried under its own chrome. */
[data-canvas-resize-handle="n"],
[data-canvas-resize-handle="s"] {
  left: 0;
  width: 100%;
  height: 7px;
  margin: -4px 0 0 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: ns-resize !important;
}
[data-canvas-resize-handle="n"] { top: 0; }
[data-canvas-resize-handle="s"] { top: 100%; }

[data-canvas-resize-handle="e"],
[data-canvas-resize-handle="w"] {
  top: 0;
  width: 7px;
  height: 100%;
  margin: 0 0 0 -4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: ew-resize !important;
}
[data-canvas-resize-handle="w"] { left: 0; }
[data-canvas-resize-handle="e"] { left: 100%; }
`.trim()

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
    let styleEl = targetDocument.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDocument.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'CanvasSelectionOverlayInjector')
      targetDocument.head.appendChild(styleEl)
    }
    const tokenBlock = buildTokenBlock(parentDocument)
    styleEl.textContent = tokenBlock
      ? `${tokenBlock}\n\n${SELECTION_CHROME_RULES}`
      : SELECTION_CHROME_RULES
  }, [targetDocument, parentDocument])

  useEffect(() => {
    const targetDoc = targetDocument
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  // Overlay root: a zero-size, out-of-flow div appended to <body>. See the
  // module docblock for why zero-size is load-bearing.
  useEffect(() => {
    if (!targetDocument.body) return
    let root = targetDocument.getElementById(OVERLAY_ROOT_ID) as HTMLDivElement | null
    if (!root) {
      root = targetDocument.createElement('div')
      root.id = OVERLAY_ROOT_ID
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
