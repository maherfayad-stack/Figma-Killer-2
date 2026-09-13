/**
 * selectionChromeCss — the selection/hover ring, node-name badge and resize-
 * handle appearance rules, plus the forwarded-token block that lets them read
 * the parent (editor) document's colour tokens. Shared by the portal-mode
 * `CanvasSelectionOverlayInjector` (same-origin, reads the parent document's
 * computed styles directly) and the in-frame live runtime (`runtime.ts`,
 * cross-origin — this module ships inside that bundle too, so it stays free
 * of admin/store imports).
 *
 * ## Why an in-frame overlay at all
 *
 * Selection/hover rings and the toolbar/inspector used to live entirely in
 * the PARENT document, positioned from measurements taken inside a zoomed,
 * panned iframe: `elementRect × zoom + iframeOffset + panOffset`, recomputed
 * on every tick. Any staleness in any term showed up as displacement, and at
 * zoom ≠ 1 the error was multiplied. The fix: render the rings and the
 * node-name badge INSIDE the frame document, in the SAME coordinate space as
 * the element they track — no conversion, no zoom multiplication, no drift.
 *
 * ## Two responsibilities
 *
 *   1. An UNLAYERED stylesheet — ring/badge CSS keyed to stable `data-*`
 *      attributes, because CSS Module classes don't exist inside a frame.
 *      Unlayered so it beats both `@layer vendor` and `@layer user-authored`
 *      regardless of author specificity.
 *   2. A single overlay ROOT div appended to `<body>` — `position: absolute;
 *      top: 0; left: 0; width: 0; height: 0; overflow: visible`. Zero-size on
 *      purpose: an `inset: 0` overlay's own size would feed back into
 *      `body.scrollHeight`, which feeds the frame's grow-to-content
 *      measurement, forever. This root never does that — its own box never
 *      exceeds 0×0, and its children (rings, badge) are positioned with
 *      `transform: translate()`, which — unlike top/left — is purely visual
 *      and never contributes to a containing block's scrollable overflow,
 *      however far outside the 0×0 box it moves them.
 *
 * A live cross-origin frame cannot read the PARENT's `getComputedStyle`
 * (different origin, different realm) — the live runtime has no equivalent
 * of {@link buildSelectionChromeTokenBlock} to call itself. Forwarding tokens
 * to a live frame is therefore the PARENT's job: it calls this same function
 * against its own document, and sends the result over the wire as an
 * `applyOverlay` stylesheet (L5). This module owns the computation either
 * way, so there is exactly one answer for "what does the ring look like".
 */

export const SELECTION_STYLE_TAG_ID = 'studio-canvas-selection-chrome'
export const SELECTION_OVERLAY_ROOT_ID = 'studio-canvas-selection-overlay-root'

/** Tokens the ring/badge CSS below reads, forwarded from the parent :root. */
export const SELECTION_CHROME_TOKENS = [
  '--canvas-selection-ring',
  '--canvas-hover-ring',
  '--canvas-selector-ring',
  '--canvas-selection-ring-color',
  '--canvas-node-badge-text',
  '--canvas-resize-handle-fill',
] as const

/**
 * Reads `SELECTION_CHROME_TOKENS` off `sourceDoc.documentElement`'s computed
 * style and emits a `:root { ... }` block redeclaring them, so a document
 * that doesn't itself define these tokens (any frame document) still
 * resolves the `var()` references in {@link SELECTION_CHROME_RULES}.
 *
 * Called with the PARENT (editor) document by the portal injector, which
 * shares no tokens with the iframe otherwise. Returns `''` when none of the
 * tokens resolve to a non-empty value (nothing to forward).
 */
export function buildSelectionChromeTokenBlock(sourceDoc: Document): string {
  const sourceStyles = getComputedStyle(sourceDoc.documentElement)
  const declarations = SELECTION_CHROME_TOKENS.flatMap((token) => {
    const value = sourceStyles.getPropertyValue(token).trim()
    return value ? [`  ${token}: ${value};`] : []
  })
  if (declarations.length === 0) return ''
  return `:root {\n${declarations.join('\n')}\n}`
}

/**
 * Ring/badge appearance rules, targeting the stable `data-*` hooks the
 * overlay owner sets on the elements it positions inside the overlay root.
 * Position (`transform`, `width`, `height`) is written imperatively per
 * element — this stylesheet owns appearance only. NO default `display: none`
 * here: the "show" path is `element.style.display = ''` (clear the inline
 * override), which falls back to whatever THIS stylesheet declares — a
 * `display: none` base rule here would make that fallback permanently
 * hidden instead of visible. The "hide" path sets the inline `display: none`
 * explicitly.
 */
export const SELECTION_CHROME_RULES = `
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
   it take pointer events.

   The cursor declarations carry !important - the ONLY ones here that do.
   The frame's own universal "cursor: default !important" (design mode)
   neutralizes the user's page affordances, and an !important on the
   universal selector cannot be beaten by specificity alone. These handles
   are editor chrome, not the user's page. Everything else in this block
   stays unprefixed. */
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

/* Edges are invisible STRIPS along the whole side, not dots at its midpoint. */
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

/** `buildSelectionChromeTokenBlock(sourceDoc)` + `SELECTION_CHROME_RULES`, combined the same way both callers need it. */
export function buildSelectionChromeStylesheet(sourceDoc: Document): string {
  const tokenBlock = buildSelectionChromeTokenBlock(sourceDoc)
  return tokenBlock ? `${tokenBlock}\n\n${SELECTION_CHROME_RULES}` : SELECTION_CHROME_RULES
}
