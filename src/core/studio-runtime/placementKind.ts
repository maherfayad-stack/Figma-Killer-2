/**
 * placementKind (PA-2) — the ONE answer to "how does this parent place its
 * children?", derived from computed style and never marked in the source.
 *
 *   - `auto-layout`: `display` is flex / inline-flex / grid / inline-grid. The
 *     parent places its in-flow children; an absolute child is "ignoring" it.
 *   - `free-frame`: positioned, not auto-layout, and EVERY element child is
 *     absolute / fixed (or there are none). Each child is placed by its own
 *     insets — the Figma frame without auto layout.
 *   - `flow`: everything else — block flow with in-flow children.
 *
 * Drag, nudge, draw, drop and the inspector all ask here instead of testing
 * `display.includes('flex')` themselves; the `placement-kind-single-source`
 * architecture gate keeps it that way.
 */

export type ParentPlacementKind = 'auto-layout' | 'free-frame' | 'flow'

/** The two families of auto layout, for callers that must tell flex from grid. */
export function autoLayoutFamily(display: string): 'flex' | 'grid' | null {
  if (display.includes('grid')) return 'grid'
  if (display.includes('flex')) return 'flex'
  return null
}

/** Does a parent with this computed `display` place its in-flow children? */
export function isAutoLayoutDisplay(display: string): boolean {
  return autoLayoutFamily(display) !== null
}

/** Absolute and fixed boxes leave the flow and are placed by their own insets. */
export function isOutOfFlow(position: string): boolean {
  return position === 'absolute' || position === 'fixed'
}

export interface PlacementParentInput {
  display: string
  position: string
}

/**
 * The computed `position` of each box a parent places: its element children,
 * with a `display: none` child skipped (it takes no space and decides nothing)
 * and a `display: contents` child looked THROUGH. A design-system call site is
 * hosted on a `display: contents` element that generates no box, so its own
 * `position` is always `static`; the box the user sees - and the one whose
 * insets place it - is what the host renders. Reading the host made a screen of
 * absolutely positioned layers (one of them a component) look like flow, so a
 * draw or drop into it was appended to the flow at the frame's (0, 0).
 */
export function childPlacementPositions(view: Window, parent: Element): string[] {
  const positions: string[] = []
  const collect = (element: Element, depth: number) => {
    for (const child of Array.from(element.children)) {
      const style = view.getComputedStyle(child)
      if (style.display === 'none') continue
      if (style.display === 'contents' && depth < 4 && child.children.length > 0) collect(child, depth + 1)
      else positions.push(style.position)
    }
  }
  collect(parent, 0)
  return positions
}

/**
 * Classify a parent. `childPositions` are the computed `position` of its
 * element children; `null` means they were not measured, so a positioned
 * non-auto-layout parent reads as `flow` (the conservative answer: it
 * reorders, it never free-places).
 */
export function parentPlacementKind(
  parent: PlacementParentInput,
  childPositions: readonly string[] | null,
): ParentPlacementKind {
  if (isAutoLayoutDisplay(parent.display)) return 'auto-layout'
  if (parent.position !== 'static' && childPositions !== null && childPositions.every(isOutOfFlow)) return 'free-frame'
  return 'flow'
}

/** What a gesture on a child does, given where it sits. */
export type PlacementOutcome =
  /** The child's own insets decide where it is: move / nudge writes offsets. */
  | 'free'
  /** The child sits in a parent's flow: the gesture reorders it. */
  | 'reorder'
  /** An in-flow child the user asked (modifier held) to place by position. */
  | 'free-from-flow'

/**
 * `placement = f(parentKind, childPositionIsFree, modifier)`. An out-of-flow
 * child is always `free`. An in-flow child reorders unless the modifier asks
 * for a position — the caller then runs the static-parent check. A
 * `free-frame` parent has no in-flow child by definition, so `parentKind` only
 * matters to callers that place a NEW layer (draw / drop): there a free-frame
 * places by position and an auto-layout / flow parent inserts in flow.
 */
export function resolvePlacement(input: {
  parentKind: ParentPlacementKind
  childPosition: string | null
  modifierHeld: boolean
}): PlacementOutcome {
  if (input.childPosition !== null) {
    if (isOutOfFlow(input.childPosition)) return 'free'
    return input.modifierHeld ? 'free-from-flow' : 'reorder'
  }
  // A layer that does not exist yet (draw / drop).
  if (input.parentKind === 'free-frame') return 'free'
  return input.modifierHeld ? 'free-from-flow' : 'reorder'
}
