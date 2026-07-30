/**
 * Per-frame iframe document reset + canvas-chrome stylesheet.
 *
 * Every breakpoint frame renders into its own iframe document
 * (IframeFrameSurface). This module owns what happens to that document's
 * `<html>`/`<body>` when the frame (re)connects: the height/overflow reset
 * that lets design frames grow to their content on the parent canvas, and
 * the canvas-only chrome stylesheet that neutralises interaction
 * affordances inside design frames. Live frames get neither — they behave
 * exactly like the published site.
 */
import { CANVAS_VIEWPORT_HEIGHT } from './resolveViewportUnits'

/**
 * Frame interaction model.
 * - 'canvas': the infinite-surface design frame. Wheel/pointer events are
 *   forwarded to the parent for pan/zoom, the iframe grows to its content
 *   height (no inner scrollbar), and the canvas-chrome CSS neutralises
 *   cursors / text selection so the frame reads as a click-to-select preview.
 * - 'live': a single real-size frame. The iframe is its own scroll viewport
 *   (published height behaviour), real cursors and text selection apply, and
 *   no events are forwarded — there is nothing to pan.
 */
export type IframeInteraction = 'canvas' | 'live'

/**
 * Inline declarations owned by the design-frame sizing contract. Authored
 * body styles still publish normally and apply in live mode, but these fields
 * cannot replace the design iframe's grow-to-content/scrollbar reset after it
 * has mounted.
 */
export const CANVAS_BODY_RESET_PROPERTIES = new Set([
  'height',
  'min-height',
  'overflow',
  'overflow-x',
  'overflow-y',
  // `position` is part of the sizing contract too: authoring `body { position:
  // static }` would hand absolutely-positioned overlays back to the initial
  // containing block and reopen the frame-growth loop below.
  'position',
])

// Canvas-only chrome: neutralize interaction affordances inside design frames.
// Kept at module scope so the React Compiler does not treat the cross-frame
// DOM writes as React-owned state mutation.
const CANVAS_CHROME_CSS = [
  '*, *::before, *::after {',
  '  cursor: default !important;',
  '  user-select: none !important;',
  '  -webkit-user-select: none !important;',
  '  -webkit-tap-highlight-color: transparent !important;',
  '}',
  // The inline text editor IS a real element in the frame. Restore text
  // selection + the I-beam on it (and its descendants) so the author can click
  // to place the caret, double-click a word, and drag-select while editing.
  '[contenteditable], [contenteditable] * {',
  '  cursor: text !important;',
  '  user-select: text !important;',
  '  -webkit-user-select: text !important;',
  '}',
  '*:focus, *:focus-visible {',
  '  outline: none !important;',
  '}',
  'iframe { pointer-events: none; }',
].join('\n')

export function applyIframeBodyReset(
  iframeDoc: Document,
  breakpointId: string,
  interaction: IframeInteraction,
): void {
  iframeDoc.body.setAttribute('data-breakpoint-id', breakpointId)
  iframeDoc.body.dataset.studioIframeInteraction = interaction
  // Live frames render the page exactly as published: html/body keep the
  // `:where(html, body) { height: 100% }` reset (the iframe is the scroll
  // viewport, short pages still fill it), and the canvas-chrome CSS
  // (cursor / user-select / nested-iframe overrides) is NOT applied — real
  // cursors, text selection, and embedded iframes behave like the live site.
  if (interaction === 'live') {
    iframeDoc.documentElement.style.height = ''
    iframeDoc.documentElement.style.overflow = ''
    return
  }
  iframeDoc.documentElement.style.height = 'auto'
  // Body opens with a DEFINITE height so an authored percentage-height chain
  // (`body { height: 100% }` → a `height: 100%` flex column → a `flex: 1` scroll
  // region) resolves instead of collapsing. The value is the constant device
  // viewport, never a measurement — see `useIframeFrameAutoHeight`, which owns
  // releasing it to `auto` for a document taller than this.
  iframeDoc.body.style.height = `${CANVAS_VIEWPORT_HEIGHT}px`
  iframeDoc.body.style.minHeight = `${CANVAS_VIEWPORT_HEIGHT}px`
  // Body is the containing block for absolutely-positioned descendants.
  //
  // An app screen's overlay root is routinely `position: absolute; inset: 0`,
  // expecting the positioned device-frame element it is mounted into. Rendered
  // standalone there is no such ancestor, so `inset: 0` resolves against the
  // INITIAL containing block — the iframe viewport — which on a grow-to-content
  // frame is the height we are deriving FROM the content. That closes a loop:
  // the overlay fills the frame, the frame grows to the overlay, forever. The
  // eSIM manual-entry sheet rode it to a 100342px frame.
  //
  // Anchoring to body instead is the same decision `resolveViewportUnits`
  // already makes for `vh`: body's definite height IS the canvas's device
  // viewport, so an overlay sized against it lands where the author meant.
  iframeDoc.body.style.position = 'relative'
  // Design frames grow to fit their content on the parent canvas. The iframe
  // document itself must never expose root scrollbars while that fit settles
  // or because authored CSS sets html/body overflow — `documentElement` is what
  // suppresses the viewport scrollbar, so that stays `hidden`.
  iframeDoc.documentElement.style.overflow = 'hidden'
  // Body, though, must NOT clip: its height is a definite pin (the percentage
  // basis above), and a page whose content runs past it would simply lose
  // everything below the fold. Overflowing visibly keeps it painted and keeps
  // `body.scrollHeight` honest for the grow-to-content measurement, while
  // `documentElement` still owns scrollbar suppression.
  iframeDoc.body.style.overflow = 'visible'
  let chrome = iframeDoc.head.querySelector('style[data-studio-canvas-chrome]')
  if (!chrome) {
    chrome = iframeDoc.createElement('style')
    chrome.setAttribute('data-studio-canvas-chrome', '')
    chrome.textContent = CANVAS_CHROME_CSS
    iframeDoc.head.appendChild(chrome)
  }
}
