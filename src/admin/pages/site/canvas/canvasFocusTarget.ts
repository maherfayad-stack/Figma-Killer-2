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
 * The board is therefore never framed by this at all (see
 * {@link resolveCanvasFocusTarget}: its frames could not be found until the
 * first selection, which then framed the board under it). Outside board mode
 * the page is the unit of "opened", and `lastCenteredKey` makes it stick to
 * once per unit: a re-run for a key already framed leaves the viewport alone.
 * A page switch is still a real navigation and still re-centers.
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
  // A board is never framed from here. Its frames share ONE synthetic
  // breakpoint id (`'studio'`) while the store's `activeBreakpointId` is the
  // site's own ('desktop'), so the frame lookup below found nothing until the
  // first press on a frame set `activeBreakpointId` to `'studio'` - and then
  // framed the board right there, under that selection. Every first selection
  // on a board moved every frame (measured: ~340 px right, ~500 px up on
  // test4, a slow open). The board's own view - what the user last left, or
  // Shift+1 - is the only thing that positions a board.
  if (activeBoardId !== null) return { centerKey: activeBoardId, shouldCenter: false }
  const centerKey = canvasPageId
  const alreadyCentered = centerKey !== null && lastCenteredKey === centerKey
  return { centerKey, shouldCenter: !alreadyCentered }
}

/** ~3s at 16ms: the per-frame iframes mount a few ticks after the effect runs, well within this. */
const FRAMING_MAX_ATTEMPTS = 200
const FRAMING_RETRY_MS = 16

interface CanvasFramingOptions {
  /** Frame the board; `false` when its frames are not laid out yet. */
  center: () => boolean
  /** The user's view (zoom + pan) as one comparable value. */
  readView: () => string
  /** Framing is over for this key - succeeded, abandoned, or overtaken by the user. */
  settle: () => void
}

/**
 * Frame the board, retrying on a short timer until its frames exist (a timer,
 * not rAF: a centering scheduled while the editor is backgrounded would
 * silently never run). Returns the cancel for the effect's cleanup.
 *
 * EVERY way framing can end settles the key - and that is the point of the
 * function. Only success used to: a board whose frames took longer than the
 * cap (a big project, a cold open) left its key unrecorded, so the next run of
 * the effect - the user's first click on another board frame, which activates
 * that page - framed the board then, and every frame jumped under the first
 * selection. Nothing moves that the user did not move: giving up, or finding
 * the user's own pan/zoom already there, ends framing for good.
 */
export function startCanvasFraming({ center, readView, settle }: CanvasFramingOptions): () => void {
  let timerId: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  const openedView = readView()
  const attempt = () => {
    if (readView() !== openedView || center()) {
      settle()
      return
    }
    attempts += 1
    if (attempts > FRAMING_MAX_ATTEMPTS) {
      settle()
      return
    }
    timerId = setTimeout(attempt, FRAMING_RETRY_MS)
  }
  attempt()
  return () => clearTimeout(timerId)
}
