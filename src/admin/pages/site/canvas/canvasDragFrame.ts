/**
 * canvasDragFrame — what ONE animation frame of an element drag does, and the
 * session it does it to.
 *
 * Extracted from `useCanvasReorderDrag.ts` when D2 G3's cross-frame branch
 * pushed that module past the 700-line ceiling. The seam is the honest one:
 * the hook is React (state, refs, listeners, the two entry points and the one
 * commit), and this is the gesture's own body — the part that measures,
 * resolves and paints, and that a test can drive without a component at all.
 *
 * ## The one rAF
 *
 * Every pointermove writes a ref and asks for a frame; this runs once per
 * painted frame and re-arms itself only while auto-pan is still moving the
 * canvas, so a stationary pointer costs nothing.
 *
 * **READ phase then WRITE phase, never interleaved.** The index refreshes, the
 * board's surface rects refresh, the foreign frame resolves and the drop
 * target resolves — all of it before the first style write. Interleaving them
 * is layout thrash, which is the rule `appliedOverlayPlacements` exists for.
 *
 * ## Three drops, one frame
 *
 *  1. **A free move (K6)** — ⌘/Ctrl held on a placeable element. Resolves no
 *     drop target at all and returns before the board is ever consulted: a
 *     coordinate drag stays inside the container it is positioned in, so there
 *     is no other frame for it to be over.
 *  2. **A cross-frame drop (D2 G3)** — the pointer is over a frame showing a
 *     DIFFERENT page. Everything is resolved and painted in THAT frame's own
 *     space (`ForeignFrameDrop.index`), into THAT frame's own drag layer,
 *     because `.viewport` is `overflow: hidden` and chrome painted in the
 *     origin frame's layer would be drawn where nobody can see it.
 *  3. **An ordinary same-page drop** — unchanged, in the origin frame.
 *
 * ## Only one layer is ever painted
 *
 * `session.paintedLayer` remembers which. Crossing a frame boundary clears the
 * one being left before the new one is written, so a drop line can never be
 * left behind in a frame the pointer has gone from — the same "hide what you
 * stopped tracking" discipline the selection overlay already follows.
 */
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import type { NodeTree, PageNode } from '@core/page-tree'
import type { CanvasDropCandidate, CanvasDropResolution, CanvasTransplantResolution } from './canvasDnd'
import { resolveCanvasDropTarget, resolveCanvasTransplantTarget } from './canvasDnd'
import { autoPanDelta } from './canvasDragAutoPan'
import {
  refreshBoardDropSurfaces,
  resolveForeignFrameDrop,
  type BoardDropSurfaces,
  type ForeignFrameDrop,
} from './canvasDragBoard'
import { paintCanvasDrag } from './canvasDragPainter'
import { dropParentOutlineRect } from './canvasDropParentOutline'
import {
  constrainToDragAxis,
  indexLocalPoint,
  refreshFrameCandidateIndex,
  type ClientPoint,
  type FrameCandidateIndex,
} from './canvasDragSession'
import {
  paintFreeMoveFrame,
  resolveFreeMove,
  type FreeMoveResolution,
  type FreeMoveStep,
} from './canvasFreeMove'
import { resolveCanvasReflowShifts, type CanvasReflowShift } from './canvasReflowPreview'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import type { CanvasTransform } from './math'

export interface DragSession {
  draggedId: string
  draggedIds: string[]
  /**
   * The page tree as it was when the gesture opened. Captured, not re-read
   * per move: a reorder drag writes nothing until `pointerup`, so the tree
   * cannot change under it — and the COMMIT re-reads the live store anyway
   * (`moveNodes` resolves its own plan), so a mid-drag resync can only cost a
   * stale PREVIEW, never a wrong write.
   */
  tree: NodeTree<PageNode>
  /** Measured once; refreshed only on a real reflow or a real transform change. */
  index: FrameCandidateIndex
  /** Where the pointer went down — the origin the activation threshold measures from. */
  origin: ClientPoint
  /** Latest pointer position, in PARENT-document client coordinates. */
  point: ClientPoint
  /** Shift was held at the last pointer event — constrain to one axis. */
  axisLocked: boolean
  /**
   * K2 — Alt was held at the last pointer event: the drop writes a COPY into
   * the resolved position instead of moving the original there.
   *
   * Read per event, never latched at `pointerdown`, so releasing Alt mid-drag
   * reverts the gesture to a move (and pressing it mid-drag turns a move into
   * a copy) — which is what every design tool does, and what makes the `+`
   * badge on the ghost an honest readout rather than a decoration. D2 G3 gives
   * it the same meaning ACROSS frames: Alt-dropping into another screen copies
   * rather than moves.
   */
  duplicating: boolean
  /**
   * K6 — ⌘/Ctrl was held at the last pointer event: the user is asking to
   * place this element by COORDINATES rather than in the child order. Read
   * per event like Alt, so the gesture can change its mind.
   */
  freeRequested: boolean
  /**
   * The cached free-move answer, and the modifier state it was taken under.
   * `undefined` means "not asked yet"; `null` means "this is an ordinary
   * reorder". Cached because it reads computed style, which is a layout read —
   * and re-taken whenever the modifier flips, because that is the one input
   * that can change it mid-gesture.
   */
  free?: FreeMoveResolution | null
  freeWanted?: boolean
  /** The last painted free-move step — exactly what `pointerup` commits. */
  freeStep: FreeMoveStep | null
  /**
   * False until the pointer has travelled the activation distance from the
   * origin. While false the session resolves no drop target, runs no auto-pan,
   * and commits no move on pointerup.
   */
  active: boolean
  /**
   * Node to select when the gesture becomes a real drag, or `null`.
   *
   * Set only by the body-drag path, and only when the pressed element was NOT
   * already part of the selection. Selecting on POINTERDOWN would make a press
   * that turns out to be a click select twice (once here, once from
   * `NodeRenderer`'s click) and would fight Cmd/Shift-click's modifier
   * semantics; selecting on ACTIVATION leaves the click path untouched and
   * still puts the ring on what the user is dragging.
   */
  selectOnActivate: string | null
  /** Frame the drag started in, so the activation selection stays frame-scoped. */
  frameId: string | null
  /**
   * D2 G3 — the PAGE the dragged element is written in, which is the file a
   * cross-frame drop is moving markup out of. `null` on a surface with no page
   * of its own (a CMS breakpoint frame), which is exactly the case where no
   * drop can be cross-file, so the whole board branch stays off.
   */
  originPageId: string | null
  /** What the ghost says — resolved once, from the tree captured above. */
  label: string
  /** The last same-page resolution painted, and what `pointerup` commits. */
  resolution: CanvasDropResolution
  /** D2 G3 — every mounted frame's client rect; see `canvasDragBoard.ts`. */
  board: BoardDropSurfaces
  /** The foreign frame the pointer is currently inside, or `null`. */
  foreign: ForeignFrameDrop | null
  /** That frame's own verdict, in ITS tree's terms. */
  foreignResolution: CanvasTransplantResolution
  /**
   * The ONE drag layer currently carrying chrome. Crossing a frame boundary
   * clears it before the new one is written — see this module's own doc.
   */
  paintedLayer: HTMLElement | null
  /**
   * K6 — the siblings that would make room for the CURRENT drop target, and
   * the key that identifies which target that was.
   *
   * Cached because the answer only changes when the target does: a pointer
   * moving inside one drop zone resolves the same `(parent, index)` on every
   * frame, and re-packing the container for it would be work whose output is
   * byte-identical. Same "skip the write whose value is unchanged" discipline
   * the painter itself follows, one level up.
   *
   * The cache is keyed on the target AND on the candidate array it was packed
   * from. The second half is what a frame REFLOW invalidates: the
   * `ResizeObserver` replaces `index.candidates` wholesale, the drop target can
   * easily resolve to the same `(parent, index)` afterwards, and without this
   * the preview would keep animating boxes at rects the page no longer has.
   */
  reflow: readonly CanvasReflowShift[]
  reflowKey: string
  reflowCandidates: readonly CanvasDropCandidate[] | null
}

/**
 * How far the pointer must travel before a press on the drag handle becomes a
 * drag. Below this the gesture is a click and commits nothing.
 *
 * Without a threshold the session went live on pointerdown, so a plain click on
 * the handle was a completed zero-distance drag: a couple of pixels of hand
 * jitter is enough for one `pointermove` to resolve a drop target, and pointerup
 * then committed `moveNodes` to it. The selected element reparented itself under
 * a click the user meant as a click — it appeared to jump away on its own.
 *
 * 4px is the usual activation distance for this gesture (`@dnd-kit`'s
 * `activationConstraint: { distance: … }`, which the DOM-panel tree uses); it is
 * under the ~5px of travel a deliberate drag covers in its first frames and over
 * anything a click produces.
 */
export const DRAG_ACTIVATE_PX = 4

export const EMPTY_RESOLUTION: CanvasDropResolution = { target: null, invalid: null }
export const EMPTY_TRANSPLANT_RESOLUTION: CanvasTransplantResolution = { target: null, invalid: null }

/** Everything one frame of the gesture needs from the hook that owns it. */
export interface CanvasDragFrameEnv {
  /** The ORIGIN frame's transform-scaled viewport. */
  viewport: HTMLElement
  /** The ORIGIN frame's iframe. */
  iframe: HTMLIFrameElement | null
  /** The ORIGIN frame's own drag layer. */
  dropLayer: HTMLElement | null
  /** The canvas root, for the auto-pan edge bands. */
  canvasRoot: HTMLElement | null
  /** D1's LIVE transform — never the store's debounced commit values. */
  transform: CanvasTransform | null
  panBy?: (dx: number, dy: number) => void
  /** Re-arm the rAF — called only when auto-pan moved the board under a still pointer. */
  scheduleFrame: () => void
  /** D2 G3 — the destination page's tree, read from the store on frame ENTRY only. */
  readPage: (pageId: string) => NodeTree<PageNode> | null
}

/** Run one animation frame of the gesture. Pure of React; writes only the DOM it owns. */
export function runCanvasDragFrame(session: DragSession, env: CanvasDragFrameEnv): void {
  // ── READ ──────────────────────────────────────────────────────────────
  refreshFrameCandidateIndex(session.index, env.viewport, session.tree, env.iframe, env.transform)

  const screenPoint = session.axisLocked
    ? constrainToDragAxis(session.origin, session.point)
    : session.point

  // K6 — a FREE move (an already-positioned element, or ⌘ held inside a
  // positioned parent) does not resolve a drop target at all: it writes a
  // position. Nothing below this branch runs for one, including the board scan
  // and the auto-pan — a coordinate drag stays inside the container it is
  // positioned in.
  const free = readSessionFreeMove(session, env.iframe)
  if (free) {
    const point = indexLocalPoint(session.index, screenPoint)
    const origin = indexLocalPoint(session.index, session.origin)
    // A gesture that was crossing frames and then had ⌘ pressed has chrome in
    // a foreign layer that nothing below will touch — clear it here.
    leaveForeignFrame(session)
    // A free move reorders nothing, so no sibling makes room for it.
    session.reflow = EMPTY_REFLOW
    session.reflowKey = ''
    session.reflowCandidates = null
    session.freeStep = paintFreeMoveFrame({
      layer: env.dropLayer,
      resolution: free,
      draggedId: session.draggedId,
      rect: session.index.candidates.find((candidate) => candidate.nodeId === session.draggedId)?.rect,
      dx: point.x - origin.x,
      dy: point.y - origin.y,
      zoom: session.index.scale,
      ghost: { point, label: session.label, duplicating: session.duplicating },
    })
    session.paintedLayer = env.dropLayer
    return
  }

  session.board = refreshBoardDropSurfaces(session.board, env.transform)
  const foreign = session.originPageId
    ? resolveForeignFrameDrop(
        session.board,
        screenPoint,
        session.originPageId,
        session.foreign,
        env.transform,
        env.readPage,
      )
    : null

  const index = foreign ? foreign.index : session.index
  const point = indexLocalPoint(index, screenPoint)
  const ghost = { point, label: session.label, duplicating: session.duplicating }

  if (foreign) {
    session.foreignResolution = resolveCanvasTransplantTarget({
      originTree: session.tree,
      destinationTree: foreign.tree,
      draggedIds: session.draggedIds,
      candidates: foreign.index.candidates,
      point,
      zoom: foreign.index.scale,
      copy: session.duplicating,
      canHaveChildren,
    })
    session.resolution = EMPTY_RESOLUTION
  } else {
    session.resolution = resolveCanvasDropTarget({
      tree: session.tree,
      draggedId: session.draggedId,
      draggedIds: session.draggedIds,
      candidates: session.index.candidates,
      point,
      zoom: session.index.scale,
      canHaveChildren,
    })
    session.foreignResolution = EMPTY_TRANSPLANT_RESOLUTION
  }

  refreshReflowPreview(session, foreign, index)
  // IX-24 — which container a before/after line lands in: a lookup in the
  // index the drop was just resolved against, so no layout read.
  const parent = dropParentOutlineRect(
    foreign ? session.foreignResolution.target : session.resolution.target,
    index.candidates,
  )

  const pan = autoPanDelta(env.canvasRoot, screenPoint)

  // ── WRITE ─────────────────────────────────────────────────────────────
  const layer = foreign ? foreign.surface.dropLayer() : env.dropLayer
  if (session.paintedLayer && session.paintedLayer !== layer) paintCanvasDrag(session.paintedLayer, null)
  session.foreign = foreign
  session.paintedLayer = layer
  paintCanvasDrag(layer, {
    ...(foreign ? session.foreignResolution : session.resolution),
    ghost,
    reflow: session.reflow,
    parent,
  })

  if (pan && env.panBy) {
    env.panBy(pan.dx, pan.dy)
    // The layer moved under a stationary pointer, so the next frame must
    // re-resolve even if no pointermove arrives. `refreshFrameCandidateIndex`
    // and `refreshBoardDropSurfaces` both pick the new origin up from the live
    // transform on their own.
    env.scheduleFrame()
  }
}

export const EMPTY_REFLOW: readonly CanvasReflowShift[] = []

/**
 * K6 — recompute the reflow preview when, and only when, the drop target the
 * gesture resolved has actually changed.
 *
 * Runs in the READ half (it reads the already-measured candidate index and
 * nothing else) and writes only the session. A cross-frame drop gets the same
 * preview **in the destination frame**, against that frame's own tree and its
 * own candidates — and never an origin-side one, because the origin frame's
 * layer is not the one being painted.
 */
function refreshReflowPreview(
  session: DragSession,
  foreign: ForeignFrameDrop | null,
  index: FrameCandidateIndex,
): void {
  const target = foreign ? session.foreignResolution.target : session.resolution.target
  const key = target ? `${foreign ? foreign.pageId : ''}|${target.parentId}|${target.index}|${session.duplicating}` : ''
  if (key === session.reflowKey && index.candidates === session.reflowCandidates) return
  session.reflowKey = key
  session.reflowCandidates = index.candidates
  if (!target) {
    session.reflow = EMPTY_REFLOW
    return
  }

  // The room the drop needs is the dragged element's own extent, which is
  // measured in the ORIGIN frame — the same frame-space units the destination's
  // rects use, so nothing needs converting even across frames.
  const dragged = session.index.candidates.find((candidate) => candidate.nodeId === session.draggedId)
  if (!dragged) {
    session.reflow = EMPTY_REFLOW
    return
  }

  session.reflow = resolveCanvasReflowShifts({
    tree: foreign ? foreign.tree : session.tree,
    candidates: index.candidates,
    parentId: target.parentId,
    index: target.index,
    draggedIds: session.draggedIds,
    draggedExtent: target.axis === 'horizontal' ? dragged.rect.width : dragged.rect.height,
    // Across frames the run is leaving a tree this preview cannot paint into;
    // within one frame it is the container the drag started in.
    originParentId: foreign ? null : (session.tree.nodes[session.draggedId]?.parentId ?? null),
    copy: session.duplicating,
  })
}

/** Drop any chrome painted into a frame the gesture has left, and forget it. */
function leaveForeignFrame(session: DragSession): void {
  if (!session.foreign) return
  const layer = session.foreign.surface.dropLayer()
  if (layer) paintCanvasDrag(layer, null)
  session.foreign = null
  session.foreignResolution = EMPTY_TRANSPLANT_RESOLUTION
}

/**
 * K6 — whether this session is a free move, cached on the session.
 *
 * `resolveFreeMove` reads computed style, which is a layout read, so it must
 * not run per frame. The cache is keyed on the MODIFIER state it was taken
 * under, because that is the one input that can flip the answer mid-gesture:
 * press ⌘ and a reorder becomes a placement, release it and it goes back.
 */
function readSessionFreeMove(
  session: DragSession,
  iframe: HTMLIFrameElement | null,
): FreeMoveResolution | null {
  if (session.free !== undefined && session.freeWanted === session.freeRequested) return session.free
  const doc = resolvePortalDocument(iframe)
  session.freeWanted = session.freeRequested
  session.free = doc
    ? resolveFreeMove({
        doc,
        tree: session.tree,
        nodeId: session.draggedId,
        candidates: session.index.candidates,
        modifierHeld: session.freeRequested,
      })
    : null
  return session.free
}

export function resolveDraggedIds(
  tree: NodeTree<PageNode>,
  selectedNodeIds: readonly string[],
): string[] {
  const result: string[] = []
  for (const id of selectedNodeIds) {
    const node = tree.nodes[id]
    if (!node) return []
    if (id === tree.rootNodeId) return []
    if (node.locked) return []
    result.push(id)
  }
  return result
}

/**
 * What the ghost says: the node's own display name, or how many are moving.
 *
 * Visual components are passed `undefined` deliberately — a
 * `base.visual-component-ref` falls back to its module name, which is the
 * right level of detail for a label that exists for half a second, and
 * reading the VC list would mean a second store read per gesture for it.
 */
export function dragLabel(tree: NodeTree<PageNode>, draggedIds: string[], draggedId: string): string {
  if (draggedIds.length > 1) return `${draggedIds.length} layers`
  const node = tree.nodes[draggedId]
  return node ? getNodeDisplayName(node, registry.get(node.moduleId), undefined) : 'Layer'
}

function canHaveChildren(moduleId: string): boolean {
  return registry.get(moduleId)?.canHaveChildren === true
}

/**
 * ERR-23 — re-address a live session after a reparse landed mid-gesture.
 *
 * A drag writes nothing until `pointerup`, but the board can be re-read under
 * it at any moment (an agent's write, the resync of the previous gesture). The
 * session captured its ids and its tree at `pointerdown`, so the release used
 * to commit against the PRE-write ids: a thrown "stale target" swallowed into
 * a `console.warn`, or — when the write permuted line numbers — a move of
 * whichever element inherited the dragged one's address.
 *
 * Every id the session holds goes through `follow`, the same answer the store
 * just mapped the selection through (`reparseNodeFollow.ts`), and everything
 * resolved against the old tree is thrown away so the next frame resolves it
 * again against `tree`: the drop target, the cross-frame verdict, the reflow
 * preview, and the free-move plan (which names the old element). The candidate
 * rects are marked stale because the frame re-rendered with new
 * `data-node-id`s.
 *
 * Returns `false` when any dragged element has no honest counterpart in the
 * new tree. The gesture cannot mean anything any more and the caller ends it.
 */
export function followDragSessionThroughReparse(
  session: DragSession,
  follow: (oldId: string) => string | null,
  tree: NodeTree<PageNode> | null,
): boolean {
  if (!tree) return false
  const inTree = (id: string | null): id is string => id !== null && Boolean(tree.nodes[id])
  const draggedIds: string[] = []
  for (const id of session.draggedIds) {
    const next = follow(id)
    if (!inTree(next)) return false
    draggedIds.push(next)
  }
  const draggedId = follow(session.draggedId)
  if (!inTree(draggedId)) return false

  session.draggedIds = draggedIds
  session.draggedId = draggedId
  if (session.selectOnActivate !== null) {
    const next = follow(session.selectOnActivate)
    session.selectOnActivate = inTree(next) ? next : null
  }
  session.tree = tree
  session.index.stale = true
  session.resolution = EMPTY_RESOLUTION
  session.foreign = null
  session.foreignResolution = EMPTY_TRANSPLANT_RESOLUTION
  session.reflow = EMPTY_REFLOW
  session.reflowKey = ''
  session.reflowCandidates = null
  session.free = undefined
  session.freeWanted = undefined
  session.freeStep = null
  return true
}
