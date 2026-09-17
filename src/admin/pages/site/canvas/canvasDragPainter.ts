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
import type { CanvasDropResolution } from './canvasDnd'
import type { ClientPoint } from './canvasDragSession'
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
}

export interface CanvasDragPaint extends CanvasDropResolution {
  ghost: CanvasDragGhost | null
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

  const ghost = paint.ghost
  if (ghost) {
    applyIndicatorVars(parts.ghost, pointStyle(ghost.point.x, ghost.point.y))
    setAttribute(parts.ghost, 'data-duplicating', ghost.duplicating ? 'true' : null)
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

  const parts: DragLayerParts = { line, invalid, chip, chipLabel, ghost, ghostLabel }
  hideAll(parts)
  layer.append(line, invalid, chip, ghost)
  layerParts.set(layer, parts)
  return parts
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
}
