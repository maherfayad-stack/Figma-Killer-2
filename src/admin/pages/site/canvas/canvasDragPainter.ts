/**
 * canvasDragPainter — what an in-flight element drag LOOKS like, written
 * straight into the DOM.
 *
 * ## Why imperative (S2)
 *
 * This used to be `CanvasDropIndicators`, a React component fed by a
 * `useState` the drag hook wrote on every `pointermove`. One raw pointermove
 * is one React commit of `BreakpointSelectionOverlay` — toolbar, rings,
 * in-place inspector and indicators — for a gesture whose entire visual
 * output is four numbers on two boxes. The session now writes those numbers
 * here and React commits nothing between `pointerdown` and `pointerup`.
 *
 * The pattern is the one `syncSelectorHighlightRings` already uses for the
 * orange affinity pool: React renders ONE empty container (`CanvasDropIndicators`)
 * and never gives it children, so nothing React owns is ever overwritten; the
 * elements inside it are created, positioned and hidden from here.
 *
 * ## Where this paints, and why not inside the frame
 *
 * The parent document's per-frame overlay layer, which is already inside
 * `CanvasTransformLayer` and therefore already pans and zooms with the board
 * — the coordinate space `CanvasDropCandidate.rect` is measured in, so the
 * rects go in unconverted. It is NOT inside the frame's iframe, and must not
 * be: canvas DOM is the DOM React renders for the user's own markup, and an
 * extra element in there breaks their `%` height chains and their
 * `>` / `+` / `:nth-child` selectors. (The selection RINGS are in the iframe
 * for the opposite reason — they track one element at every zoom and were the
 * `standing-03` drift defect. A drop line is transient, is measured from the
 * same scan that produced the candidate, and has no element to drift from.)
 *
 * ## Read phase, then write phase
 *
 * Every function here is pure writes. The caller resolves the drop target
 * first and calls this second, so no measurement is interleaved with a style
 * write — the layout-thrash rule `appliedOverlayPlacements` exists for.
 * Each write is also skipped when the value is unchanged, so a pointer that
 * moves inside one drop zone costs nothing after the first frame.
 */
import type { SnapGuide } from './boardSnapping'
import type { CanvasDragPaintTarget, CanvasInvalidDropTarget } from './canvasDnd'
import type { ClientPoint } from './canvasDragSession'
import type { CanvasReflowShift } from './canvasReflowPreview'
import { REFLOW_SHIFT_LIMIT } from './canvasReflowPreview'
import { prefersReducedMotion } from './playbackMotion'
import {
  dropIndicatorStyle,
  pointStyle,
  rectStyle,
  type CanvasDropVars,
} from './canvasSelectionOverlayPositioning'
import styles from './BreakpointSelectionOverlay.module.css'

/** Where the ghost sits and what it says. */
export interface CanvasDragGhost {
  /** Pointer position in the layer's own (frame-space) coordinates. */
  point: ClientPoint
  /** What is being dragged — the node's display name, or "N layers". */
  label: string
  /** K2 — Alt is held, so the drop writes a COPY. Renders the `+` badge. */
  duplicating: boolean
  /**
   * G15 — this chip is answering a gesture that will NOT land (a non-image
   * file, the empty board). Renders in the refusal's own colours so the answer
   * is legible before release rather than as a toast afterwards.
   */
  refusing?: boolean
}

/**
 * How long a sibling takes to make room. Short enough that a pointer sweeping
 * across four slots does not leave a queue of boxes still travelling behind
 * it, long enough to read as movement rather than a jump.
 */
const REFLOW_DURATION_MS = 120
const REFLOW_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

export interface CanvasDragPaint {
  target: CanvasDragPaintTarget | null
  invalid: CanvasInvalidDropTarget | null
  ghost: CanvasDragGhost | null
  /**
   * K6 — alignment guides for a FREE move: the sibling edges and centres the
   * moved element snapped to, in the same frame space as the rects above.
   * Empty for an ordinary reorder, which does not move the element freely and
   * therefore has nothing to align.
   */
  guides?: readonly SnapGuide[]
  /**
   * K6's reflow preview: the siblings that would make room for this drop, and
   * how far each travels (`canvasReflowPreview.ts`). Empty for a free move, a
   * refused position, and any layout the packing model stands down for.
   */
  reflow?: readonly CanvasReflowShift[]
}

/**
 * The child elements of one drag layer, created on first paint and reused for
 * the rest of the session. Keyed off the layer element so a board with N
 * frames keeps N independent sets without any of them knowing about the
 * others.
 */
interface DragLayerParts {
  line: HTMLDivElement
  invalid: HTMLDivElement
  chip: HTMLDivElement
  chipLabel: HTMLSpanElement
  ghost: HTMLDivElement
  ghostLabel: HTMLSpanElement
  /**
   * K6's alignment guides, POOLED rather than created per frame: at most two
   * exist at once (one per axis), and a snap that appears and disappears as
   * the pointer crosses a threshold would otherwise mount and unmount DOM at
   * pointer rate. Reused and hidden, the same way the selector-affinity ring
   * pool is.
   */
  guides: HTMLDivElement[]
  /**
   * K6's reflow preview — one box per sibling that would make room.
   *
   * Created EAGERLY, all `REFLOW_SHIFT_LIMIT` of them at once, and never
   * removed: the set of shifting siblings changes every time the drop line
   * crosses a slot, and minting and dropping elements at pointer rate is the
   * one thing this whole painter exists to avoid. Same fixed pool, same
   * reason, as the guides above and as `syncSelectorHighlightRings`.
   */
  reflow: ReflowPart[]
}

/** One pooled reflow box, the travel it is on, and both ends of that travel. */
interface ReflowPart {
  element: HTMLDivElement
  /** Where the current travel ENDS — also the resting delta once it finishes. */
  dx: number
  dy: number
  /** Where the current travel STARTED, so a retarget can interpolate from mid-flight. */
  fromDx: number
  fromDy: number
  animation: Animation | null
}

const layerParts = new WeakMap<HTMLElement, DragLayerParts>()

/** Paint one frame's drag chrome. `null` clears it. */
export function paintCanvasDrag(layer: HTMLElement | null, paint: CanvasDragPaint | null): void {
  if (!layer) return
  if (!paint) {
    const existing = layerParts.get(layer)
    if (existing) hideAll(existing)
    return
  }

  const parts = layerParts.get(layer) ?? createParts(layer)

  if (paint.target) {
    applyIndicatorVars(parts.line, dropIndicatorStyle(paint.target))
    setAttribute(parts.line, 'data-position', paint.target.position)
    setAttribute(parts.line, 'data-axis', paint.target.axis)
    show(parts.line)
  } else {
    hide(parts.line)
  }

  const invalid = paint.invalid
  if (invalid) {
    applyIndicatorVars(parts.invalid, rectStyle(invalid.rect))
    setAttribute(parts.invalid, 'data-axis', invalid.axis)
    // Present when this box means "this position would refuse the SOURCE
    // write" (G5 — a real drop target the store's own gate would still
    // reject), distinct from an ordinary structural rejection (locked node,
    // cycle) which carries no constraint at all.
    setAttribute(parts.invalid, 'data-refusal-reason', invalid.constraint ? 'source-writeback' : null)
    show(parts.invalid)
  } else {
    hide(parts.invalid)
  }

  if (invalid?.constraint) {
    applyIndicatorVars(parts.chip, rectStyle(invalid.rect))
    setAttribute(parts.chip, 'data-refusal-reason', invalid.constraint.reason)
    setText(parts.chipLabel, invalid.constraint.explanation)
    show(parts.chip)
  } else {
    hide(parts.chip)
  }

  paintGuides(parts, layer, paint.guides ?? [])
  paintReflow(parts, paint.reflow ?? [])

  const ghost = paint.ghost
  if (ghost) {
    applyIndicatorVars(parts.ghost, pointStyle(ghost.point.x, ghost.point.y))
    setAttribute(parts.ghost, 'data-duplicating', ghost.duplicating ? 'true' : null)
    setAttribute(parts.ghost, 'data-refusing', ghost.refusing ? 'true' : null)
    setText(parts.ghostLabel, ghost.label)
    show(parts.ghost)
  } else {
    hide(parts.ghost)
  }
}

function createParts(layer: HTMLElement): DragLayerParts {
  const doc = layer.ownerDocument
  const line = doc.createElement('div')
  line.className = styles.dropIndicator
  line.setAttribute('aria-hidden', 'true')

  const invalid = doc.createElement('div')
  invalid.className = styles.invalidDropIndicator
  invalid.setAttribute('aria-hidden', 'true')

  const chip = doc.createElement('div')
  chip.className = styles.dropRefusalChip
  chip.setAttribute('data-testid', 'canvas-drop-refusal')
  chip.setAttribute('aria-hidden', 'true')
  const chipLabel = doc.createElement('span')
  chipLabel.className = styles.dropRefusalChipLabel
  chip.appendChild(chipLabel)

  // The ghost counter-scales by `1 / --canvas-zoom` for the same reason the
  // refusal chip does: it is a label about the gesture, not a part of the
  // page, so it must stay one physical size at 25% and at 400%.
  const ghost = doc.createElement('div')
  ghost.className = styles.dragGhost
  ghost.setAttribute('data-canvas-drag-ghost', 'true')
  ghost.setAttribute('aria-hidden', 'true')
  const ghostLabel = doc.createElement('span')
  ghostLabel.className = styles.dragGhostLabel
  ghost.appendChild(ghostLabel)

  const reflow: ReflowPart[] = []
  for (let i = 0; i < REFLOW_SHIFT_LIMIT; i++) {
    const element = doc.createElement('div')
    element.className = styles.reflowGhost
    // Stable attribute, not the hashed CSS Module class: this is how a test
    // names a reflow box, the same way the ghost and the refusal chip are
    // named above.
    element.setAttribute('data-canvas-reflow-ghost', 'true')
    element.setAttribute('aria-hidden', 'true')
    reflow.push({ element, dx: 0, dy: 0, fromDx: 0, fromDy: 0, animation: null })
  }

  const parts: DragLayerParts = { line, invalid, chip, chipLabel, ghost, ghostLabel, guides: [], reflow }
  hideAll(parts)
  layer.append(line, invalid, chip, ghost, ...reflow.map((part) => part.element))
  layerParts.set(layer, parts)
  return parts
}

/**
 * K6 — move each pooled box to the sibling it stands for and travel it to the
 * delta that sibling would take.
 *
 * ## Why WAAPI and not a CSS transition
 *
 * A transition interpolates from the element's PREVIOUS computed style, which
 * an element created in this same task does not have, and which nothing here
 * may ask for anyway — reading a computed style inside the write phase is the
 * layout-thrash rule this whole painter is arranged around. `element.animate`
 * needs neither: the FROM is a number this module already holds (`part.dx`),
 * and retargeting mid-travel reads the eased progress off the running
 * animation's own timing rather than off the DOM.
 *
 * ## Why `translate` and not `transform`
 *
 * The box is POSITIONED by `transform: translate(var(--canvas-drop-x), …)`,
 * the same rect channel every other indicator uses. Animating the same
 * property would mean animating its position as well, so a re-measure would
 * slide the box across the frame. The independent `translate` property
 * composes on top and is the only thing that ever moves.
 *
 * A box that stops shifting travels back to zero and then fades — it is the
 * same sibling returning to its own place, which is exactly what the drop no
 * longer landing there means.
 */
function paintReflow(parts: DragLayerParts, shifts: readonly CanvasReflowShift[]): void {
  for (let i = 0; i < parts.reflow.length; i++) {
    const part = parts.reflow[i]!
    const shift = shifts[i]
    if (shift) {
      applyIndicatorVars(part.element, rectStyle(shift.rect))
      setAttribute(part.element, 'data-shifting', 'true')
      travelReflow(part, shift.dx, shift.dy)
    } else {
      setAttribute(part.element, 'data-shifting', null)
      travelReflow(part, 0, 0)
    }
  }
}

/** Animate one pooled box from the delta it is showing to the one it should show. */
function travelReflow(part: ReflowPart, dx: number, dy: number): void {
  if (part.dx === dx && part.dy === dy) return

  const from = currentReflowDelta(part)
  part.animation?.cancel()
  part.animation = null
  part.fromDx = from.dx
  part.fromDy = from.dy
  part.dx = dx
  part.dy = dy

  const to = `${dx}px ${dy}px`
  // No WAAPI (happy-dom, and the reduced-motion preference) — the box simply
  // is where it would end up. `prefers-reduced-motion` must be asked in script
  // here for the reason `playbackMotion` records: the global CSS clamp cannot
  // see a scripted animation.
  if (typeof part.element.animate !== 'function' || prefersReducedMotion()) {
    part.element.style.translate = to
    return
  }

  part.animation = part.element.animate(
    [{ translate: `${part.fromDx}px ${part.fromDy}px` }, { translate: to }],
    { duration: REFLOW_DURATION_MS, easing: REFLOW_EASING, fill: 'forwards' },
  )
}

/**
 * Where a pooled box is RIGHT NOW: its committed delta when nothing is
 * running, or the eased interpolation of the travel still in flight.
 *
 * `getComputedTiming().progress` is the timing function already applied, so
 * this recovers the on-screen position without touching the DOM — which is the
 * whole point. Without it a pointer sweeping across slots would snap each box
 * back to its last target before starting the next travel.
 */
function currentReflowDelta(part: ReflowPart): { dx: number; dy: number } {
  const animation = part.animation
  if (!animation || typeof animation.effect?.getComputedTiming !== 'function') {
    return { dx: part.dx, dy: part.dy }
  }
  const progress = animation.effect.getComputedTiming().progress
  if (typeof progress !== 'number') return { dx: part.dx, dy: part.dy }
  return {
    dx: part.fromDx + (part.dx - part.fromDx) * progress,
    dy: part.fromDy + (part.dy - part.fromDy) * progress,
  }
}

/**
 * K6 — draw one hairline per snapped axis, growing the pool on demand and
 * hiding the surplus rather than removing it (`syncSelectorHighlightRings`'s
 * own pattern). A guide is a zero-thickness line, so it is written through the
 * same `--canvas-drop-*` rect channel with one dimension pinned to 0 and the
 * stylesheet giving it its 1px.
 */
function paintGuides(parts: DragLayerParts, layer: HTMLElement, guides: readonly SnapGuide[]): void {
  for (let i = 0; i < guides.length; i++) {
    const guide = guides[i]!
    let element = parts.guides[i]
    if (!element) {
      element = layer.ownerDocument.createElement('div')
      element.className = styles.snapGuide
      element.setAttribute('aria-hidden', 'true')
      parts.guides.push(element)
      layer.appendChild(element)
    }
    const horizontal = guide.axis === 'y'
    applyIndicatorVars(
      element,
      rectStyle(
        horizontal
          ? { left: guide.start, top: guide.position, right: guide.end, bottom: guide.position, width: guide.end - guide.start, height: 0 }
          : { left: guide.position, top: guide.start, right: guide.position, bottom: guide.end, width: 0, height: guide.end - guide.start },
      ),
    )
    setAttribute(element, 'data-axis', guide.axis)
    show(element)
  }
  for (let i = guides.length; i < parts.guides.length; i++) hide(parts.guides[i]!)
}

/**
 * Write the `--canvas-drop-*` custom properties the stylesheet reads back.
 * `setProperty` is what a custom property needs — `element.style['--x'] = …`
 * is not a thing — and the read-back guard keeps a pointer that stays inside
 * one drop zone from touching the DOM at all after the first frame.
 */
function applyIndicatorVars(element: HTMLElement, vars: CanvasDropVars): void {
  for (const [name, value] of Object.entries(vars)) {
    if (element.style.getPropertyValue(name) === value) continue
    element.style.setProperty(name, value)
  }
}

function setAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name)
    return
  }
  if (element.getAttribute(name) === value) return
  element.setAttribute(name, value)
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent === text) return
  element.textContent = text
}

function show(element: HTMLElement): void {
  if (element.style.display !== 'none') return
  element.style.display = ''
}

function hide(element: HTMLElement): void {
  if (element.style.display === 'none') return
  element.style.display = 'none'
}

function hideAll(parts: DragLayerParts): void {
  hide(parts.line)
  hide(parts.invalid)
  hide(parts.chip)
  hide(parts.ghost)
  for (const guide of parts.guides) hide(guide)
  // The reflow boxes stay in the DOM between gestures — see `DragLayerParts`
  // for why they are never created on demand — so the end of a drag RESETS
  // them (no travel, no attribute) rather than removing them. A cancelled
  // animation would otherwise still be holding the last delta the next drag
  // would travel from.
  for (const part of parts.reflow) {
    part.animation?.cancel()
    part.animation = null
    part.dx = 0
    part.dy = 0
    part.fromDx = 0
    part.fromDy = 0
    part.element.style.translate = '0px 0px'
    setAttribute(part.element, 'data-shifting', null)
  }
}
