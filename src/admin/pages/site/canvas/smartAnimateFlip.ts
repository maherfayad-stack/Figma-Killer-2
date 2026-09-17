/**
 * smartAnimateFlip — the DOM half of a smart animate: two measured rects per
 * matched pair, and a WAAPI travel between them.
 *
 * WHICH elements are a pair is decided purely, in `@core/studio-prototype`'s
 * `smartAnimate.ts`, by re-resolving the outgoing node's `NodeHint` against the
 * incoming tree. This file never asks that question — it only measures the
 * answer and moves something between the two places.
 *
 * NOTHING HERE TOUCHES EITHER SCREEN
 * ──────────────────────────────────
 * Both screens are live `<iframe>`s rendering the user's own components, and the
 * repo's first canvas rule is that the canvas DOM is the DOM React renders.
 * Writing a transform onto a matched element inside a frame would mean writing
 * a transform into the user's document — where it changes what their own
 * `%`/flex chains and `backdrop-filter`s resolve against, and where a
 * cancelled animation leaves it behind. Animating the IFRAMES is equally out:
 * they are the two screens, and a smart animate is precisely the transition in
 * which the screens do not move as wholes.
 *
 * So the travel happens on GHOSTS: parent-document boxes in an overlay layer
 * that belongs to the editor, positioned in that layer's coordinates, painted
 * from a snapshot of the source element's computed style, and removed when the
 * animation ends. The two real screens cross-dissolve underneath them — which
 * IS "unmatched nodes dissolve", and also means a matched element that did not
 * move needs no ghost at all: identical pixels cross-fading are invisible.
 *
 * A ghost is a box and a line of text, not a clone. `importNode` would copy the
 * subtree without the iframe's stylesheets, so a deep clone in the parent
 * document renders as unstyled markup — visibly worse than a rectangle with the
 * right colour, radius, border, shadow and type.
 *
 * MEASURE, THEN WRITE — NEVER BOTH IN ONE PASS
 * ────────────────────────────────────────────
 * `planSmartAnimate` reads every rect and every computed style and returns a
 * plan. `runSmartAnimate` creates the elements and starts the animations. The
 * caller puts a `requestAnimationFrame` between them. Interleaving the two is
 * layout thrash, and here it would be a forced reflow per pair across two
 * documents.
 */
import type { ScreenNodeMatch } from '@core/studio-prototype'
import { nodeVisualRect, type ClientRectLike } from './canvasDomGeometry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import { EASE_IOS, prefersReducedMotion } from './playbackMotion'

/** A box in the ghost layer's own coordinate space. */
export interface GhostRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * What a ghost is painted with — the subset of the source element's computed
 * style that decides whether a rectangle reads as the same thing the user was
 * just looking at.
 */
export interface GhostPaint {
  background: string
  borderRadius: string
  border: string
  boxShadow: string
  color: string
  font: string
  letterSpacing: string
  textAlign: string
  /** The element's own text, when it has no element children to draw it. */
  text: string
}

export interface SmartAnimateGhost {
  from: GhostRect
  to: GhostRect
  paint: GhostPaint
}

/** Sub-pixel differences are not motion; animating them is work for nothing. */
const MOVED_EPSILON = 0.5

/** Longer than this and a ghost's text is a paragraph, not a label. */
const GHOST_TEXT_MAX = 160

function iframeIn(slot: HTMLElement | null): HTMLIFrameElement | null {
  return slot?.querySelector('iframe') ?? null
}

/**
 * A rect measured INSIDE an iframe, expressed in `layer`'s coordinates.
 *
 * The scale term is the iframe's own: a live frame is rendered at the
 * breakpoint's CSS width and then laid out at whatever width the viewport
 * gives it, so its internal pixels and the parent's are not the same size.
 * `measureCanvasDropCandidates` does the same conversion for the same reason.
 */
function toLayerRect(
  inner: ClientRectLike,
  iframe: HTMLIFrameElement,
  layerRect: ClientRectLike,
): GhostRect {
  const outer = iframe.getBoundingClientRect()
  const scale = iframe.clientWidth > 0 ? outer.width / iframe.clientWidth : 1
  return {
    left: outer.left + inner.left * scale - layerRect.left,
    top: outer.top + inner.top * scale - layerRect.top,
    width: inner.width * scale,
    height: inner.height * scale,
  }
}

function elementFor(doc: Document, nodeId: string): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[data-node-id="${nodeId.replace(/"/g, '\\"')}"]`)
}

/**
 * Whether this element draws its own text, or merely contains elements that do.
 * A ghost of a card should not repeat every word inside it.
 */
function ownText(element: HTMLElement): string {
  if (element.childElementCount > 0) return ''
  const text = element.textContent?.trim() ?? ''
  return text.length > 0 && text.length <= GHOST_TEXT_MAX ? text : ''
}

function paintOf(element: HTMLElement, view: Window): GhostPaint {
  const style = view.getComputedStyle(element)
  return {
    background: style.backgroundColor,
    borderRadius: style.borderRadius,
    border: style.border,
    boxShadow: style.boxShadow,
    color: style.color,
    font: style.font || `${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`,
    letterSpacing: style.letterSpacing,
    textAlign: style.textAlign,
    text: ownText(element),
  }
}

function moved(from: GhostRect, to: GhostRect): boolean {
  return (
    Math.abs(from.left - to.left) > MOVED_EPSILON ||
    Math.abs(from.top - to.top) > MOVED_EPSILON ||
    Math.abs(from.width - to.width) > MOVED_EPSILON ||
    Math.abs(from.height - to.height) > MOVED_EPSILON
  )
}

/**
 * Measure every pair. READ ONLY — it creates nothing and starts nothing.
 *
 * A pair whose element is missing on either side, or that did not move, yields
 * no ghost: the first is a screen that has not laid out yet (the first
 * navigation into the back slot mounts its iframe), the second needs no
 * animation because the cross-dissolve underneath already shows it unchanged.
 */
export function planSmartAnimate(
  matches: readonly ScreenNodeMatch[],
  fromSlot: HTMLElement | null,
  toSlot: HTMLElement | null,
  layer: HTMLElement,
): SmartAnimateGhost[] {
  const fromIframe = iframeIn(fromSlot)
  const toIframe = iframeIn(toSlot)
  if (!fromIframe || !toIframe) return []

  // Portal mode only, like every other same-origin measurement under `canvas/`.
  // A bridge-mode (Tier 2, cross-origin) frame has no readable `Document`, so a
  // smart animate between two of them measures nothing and falls back to the
  // cross-dissolve the screens are already playing — a quieter transition, not
  // a broken one.
  const fromDoc = resolvePortalDocument(fromIframe)
  const toDoc = resolvePortalDocument(toIframe)
  if (!fromDoc || !toDoc) return []
  const toView = toDoc.defaultView
  if (!toView) return []

  const layerRect = layer.getBoundingClientRect()
  const ghosts: SmartAnimateGhost[] = []

  for (const match of matches) {
    const fromEl = elementFor(fromDoc, match.fromNodeId)
    const toEl = elementFor(toDoc, match.toNodeId)
    if (!fromEl || !toEl) continue

    // `nodeVisualRect` rather than `getBoundingClientRect`: a `display:
    // contents` host or a fragment node has no box of its own and measures as
    // zeros, and it falls back to the union of its children.
    const fromInner = nodeVisualRect(fromEl)
    const toInner = nodeVisualRect(toEl)
    if (!fromInner || !toInner) continue
    if (fromInner.width === 0 || toInner.width === 0) continue

    const from = toLayerRect(fromInner, fromIframe, layerRect)
    const to = toLayerRect(toInner, toIframe, layerRect)
    if (!moved(from, to)) continue

    ghosts.push({ from, to, paint: paintOf(toEl, toView) })
  }

  return ghosts
}

/**
 * One ghost, at its DESTINATION and painted from the incoming element.
 *
 * Positioned at the destination rather than the origin so the final frame needs
 * no fill-forward: at rest the ghost is exactly where the real element already
 * is, underneath, and removing it is invisible.
 *
 * The inline styles are imperative on an element this module created — not a
 * JSX `style={{}}` and not a CSS-Module class, because every value here is
 * either a measurement or a snapshot of the USER's computed style, and neither
 * can be spelled as a token.
 */
export function createGhostElement(doc: Document, ghost: SmartAnimateGhost): HTMLElement {
  const element = doc.createElement('div')
  element.setAttribute('aria-hidden', 'true')
  element.setAttribute('data-smart-animate-ghost', 'true')
  Object.assign(element.style, {
    position: 'absolute',
    left: `${ghost.to.left}px`,
    top: `${ghost.to.top}px`,
    width: `${ghost.to.width}px`,
    height: `${ghost.to.height}px`,
    boxSizing: 'border-box',
    overflow: 'hidden',
    background: ghost.paint.background,
    borderRadius: ghost.paint.borderRadius,
    border: ghost.paint.border,
    boxShadow: ghost.paint.boxShadow,
    color: ghost.paint.color,
    font: ghost.paint.font,
    letterSpacing: ghost.paint.letterSpacing,
    textAlign: ghost.paint.textAlign,
  })
  if (ghost.paint.text) element.textContent = ghost.paint.text
  return element
}

/**
 * Create the ghosts and run the travel. Returns a canceller that stops every
 * animation and removes every element — the caller's effect cleanup, so a
 * navigation that lands mid-transition does not leave a box on screen.
 *
 * `fill: 'backwards'` for the same reason `playbackMotion.play` uses it — a
 * held transform on an ancestor silently disables `backdrop-filter` on
 * everything inside it.
 *
 * An engine with no WAAPI (happy-dom, and old browsers) gets the screen without
 * the travel rather than a box that never leaves: the ghosts are removed on the
 * spot.
 */
export function runSmartAnimate(
  layer: HTMLElement,
  ghosts: readonly SmartAnimateGhost[],
  duration: number,
): () => void {
  const doc = layer.ownerDocument
  const elements: HTMLElement[] = []
  const animations: Animation[] = []
  const ms = prefersReducedMotion() ? 1 : duration

  for (const ghost of ghosts) {
    const element = createGhostElement(doc, ghost)
    layer.appendChild(element)
    elements.push(element)

    if (typeof element.animate !== 'function') continue
    animations.push(
      element.animate(
        [
          {
            transform: `translate(${ghost.from.left - ghost.to.left}px, ${ghost.from.top - ghost.to.top}px)`,
            width: `${ghost.from.width}px`,
            height: `${ghost.from.height}px`,
          },
          { transform: 'translate(0px, 0px)', width: `${ghost.to.width}px`, height: `${ghost.to.height}px` },
        ],
        { duration: ms, easing: EASE_IOS, fill: 'backwards' },
      ),
    )
  }

  let done = false
  const clear = () => {
    if (done) return
    done = true
    for (const animation of animations) animation.cancel()
    for (const element of elements) element.remove()
  }

  if (animations.length === 0) {
    clear()
    return () => {}
  }
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(clear)
  return clear
}
