/**
 * Which event counts as "a document opened" for the canvas's initial framing.
 *
 * `CanvasRoot` centers the viewport on the active breakpoint's frame when a
 * document opens. The question this answers is what "opens" means, because the
 * naive answer — the active page changed — is wrong on a studio board and made
 * the canvas appear to run away from the user.
 *
 * On a board, every page is on screen at once as its own frame, and clicking any
 * element activates that page (`BoardFramesLayer`'s `onPointerDownCapture` →
 * `openPageInCanvas`). So the active page is a *selection artifact* there, not a
 * navigation. Worse, all board frames render a `BreakpointFrame` built by
 * `buildStudioBreakpoint`, which varies only `width` — they share one breakpoint
 * id, so the centering query always resolves to the first frame in DOM order.
 * Keying on the page meant every selection snapped the canvas back to frame #1.
 *
 * The board is therefore the unit of "opened" when there is one, and the page
 * otherwise. `lastCenteredKey` makes it stick to once per unit: a re-run for a
 * key already framed leaves the viewport alone. Outside board mode nothing
 * changes — a page switch is still a real navigation and still re-centers.
 */

export interface CanvasFocusTargetInput {
  /** The open studio board, or `null` outside board mode (CMS page / Visual Component). */
  activeBoardId: string | null
  /** The active canvas document's page id, or `null` during the skeleton phase. */
  canvasPageId: string | null
  /** The key the canvas was last successfully framed for. */
  lastCenteredKey: string | null
}

export interface CanvasFocusTarget {
  /**
   * The key to remember once framing succeeds. `null` during the skeleton phase,
   * which is deliberately never recorded — the real document has not arrived yet,
   * so its framing must not be treated as already done.
   */
  centerKey: string | null
  /** False when this key has already been framed, i.e. a selection-driven re-run. */
  shouldCenter: boolean
}

export function resolveCanvasFocusTarget({
  activeBoardId,
  canvasPageId,
  lastCenteredKey,
}: CanvasFocusTargetInput): CanvasFocusTarget {
  const centerKey = activeBoardId ?? canvasPageId
  const alreadyCentered = centerKey !== null && lastCenteredKey === centerKey
  return { centerKey, shouldCenter: !alreadyCentered }
}
