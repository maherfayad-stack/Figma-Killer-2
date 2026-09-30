/**
 * canvasPressTarget — WHICH layer a press on the canvas means (Figma's
 * selection depth).
 *
 * The browser reports the innermost element under the pointer. That is almost
 * never what a designer means: pressing a card's title to move the card used
 * to grab the title, and a click drilled straight to the deepest `<span>`, so
 * a container could only be selected by aiming at its padding. Figma's rule,
 * which every gesture here now shares:
 *
 *  - **A press selects at the current selection depth.** With nothing
 *    selected, that is the frame's top level. With a selection, it is the
 *    level of the selection: the child of the deepest node the selection and
 *    the pressed element have in common, on the way down to the pressed
 *    element. Clicking a sibling of the selected layer selects that sibling,
 *    not something inside it.
 *  - **A press inside a selected layer means that layer.** Dragging from
 *    anywhere inside it moves it; clicking inside it keeps it.
 *  - **Deeper is explicit**: ⌘/Ctrl held (`deep`) goes straight to the
 *    innermost layer, and a double-click steps ONE container level down —
 *    or, on a leaf (text, image, graphic), straight to it and into its edit
 *    (`resolveCanvasDrillTarget`).
 *  - **The frame itself is transparent.** The page root (`base.body`) and, when
 *    it has exactly one child, that child — the page component's own root
 *    element, which IS the screen — are the frame, the way a Figma top-level
 *    frame is. Pressing inside them selects their children; pressing their own
 *    background still selects them.
 *
 * A closed `studio.instance` and an inlined Visual Component body are clamped
 * to their boundary FIRST (`clampToComponentBoundary`): a component is one
 * layer until it is entered, whatever depth rule applies around it.
 *
 * Every consumer calls this module — the portal frame's click, hover,
 * double-click and body drag (`NodeRenderer`, `useCanvasBodyDragTrigger`), and
 * a bridge frame's forwarded pointer (`useBridgeFrameInteraction`,
 * `useBridgeBodyDragTrigger`) — so what a press would SELECT and what a press
 * would DRAG can never disagree. Pure: a tree and a context in, an id out.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import { findEnclosingComponentRef, findEnclosingInstance, type AnnotatedPageNode } from './canvasSelectionUtils'

/** Everything outside the tree a press resolution depends on. */
export interface CanvasPressContext {
  /** The selection, scoped to the frame the press landed in — empty when it lives in another frame. */
  selectedIds: readonly string[]
  /** `studio.instance` ids the user has opened (double-click / Enter). */
  enteredInstanceIds: readonly string[]
  /** B3 — an inlined Visual Component body clamps to its ref. Off on the VC's own canvas. */
  vcLockdown: boolean
}

/**
 * The press context for a frame, read from the store state the caller already
 * holds. A selection made in another board frame (`selectedNodeFrameId`) sets
 * no depth here: "duplicate as variant" siblings share node ids, and a
 * selection over there must not decide what a press over here means.
 */
export function canvasPressContext(state: EditorStore, frameId: string | null): CanvasPressContext {
  const scoped = !state.selectedNodeFrameId || state.selectedNodeFrameId === frameId
  return {
    selectedIds: scoped ? state.selectedNodeIds : [],
    enteredInstanceIds: state.enteredInstanceIds,
    vcLockdown: state.activeDocument?.kind !== 'visualComponent',
  }
}

/**
 * The innermost layer the press can land on at all: `hitId` itself, or the
 * boundary of the closed component it sits inside.
 */
export function clampToComponentBoundary(
  tree: NodeTree<PageNode>,
  hitId: string,
  context: Pick<CanvasPressContext, 'enteredInstanceIds' | 'vcLockdown'>,
): string {
  const instance = findEnclosingInstance(tree, hitId, context.enteredInstanceIds)
  if (instance !== null) return instance
  if (context.vcLockdown) {
    const enclosing = findEnclosingComponentRef(tree.nodes as Record<string, AnnotatedPageNode>, hitId)
    if (enclosing !== null && !enclosing.isInsideSlotContent) return enclosing.refId
  }
  return hitId
}

/** Root → `id`, both inclusive. Empty when `id` is not in `tree`. */
function pathTo(tree: NodeTree<PageNode>, id: string): string[] {
  const path: string[] = []
  const seen = new Set<string>()
  let current: PageNode | undefined = tree.nodes[id]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current.id)
    current = current.parentId ? tree.nodes[current.parentId] : undefined
  }
  return path.reverse()
}

/**
 * How deep the FRAME goes on `path`, as an index: the root is always frame,
 * and so is the root's only child — the page component's own root element.
 */
function frameDepthOn(tree: NodeTree<PageNode>, path: readonly string[]): number {
  const root = tree.nodes[tree.rootNodeId]
  if (!root || path[0] !== root.id) return 0
  return root.children.length === 1 && path[1] === root.children[0] ? 1 : 0
}

/** Index of the deepest node `a` and `b` share, or -1. */
function deepestCommonIndex(a: readonly string[], b: readonly string[]): number {
  let index = -1
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i += 1) index = i
  return index
}

/**
 * The layer a press on `hitId` means — see the module doc. `deep` is ⌘/Ctrl
 * held: the innermost layer (still clamped to a closed component).
 */
export function resolveCanvasPressTarget(
  tree: NodeTree<PageNode>,
  hitId: string,
  context: CanvasPressContext,
  { deep }: { deep: boolean },
): string {
  const leaf = clampToComponentBoundary(tree, hitId, context)
  if (deep) return leaf
  const path = pathTo(tree, leaf)
  if (path.length === 0) return leaf
  const frameDepth = frameDepthOn(tree, path)

  // A press inside a selected layer means that layer. The deepest one wins, so
  // a selected child inside a selected parent keeps the child. The frame's own
  // levels are transparent: a selected screen root still lets a press reach
  // its children.
  const selected = new Set(context.selectedIds)
  for (let i = path.length - 1; i > frameDepth; i -= 1) {
    if (selected.has(path[i]!)) return path[i]!
  }

  // Otherwise the press selects at the selection's level: below the deepest
  // node any selected layer shares with the pressed one, never above the frame.
  let contextIndex = frameDepth
  for (const id of context.selectedIds) {
    const common = deepestCommonIndex(path, pathTo(tree, id))
    if (common > contextIndex) contextIndex = common
  }
  return contextIndex >= path.length - 1 ? leaf : path[contextIndex + 1]!
}

/** What a double-click selects before it does anything else — see {@link resolveCanvasDrillTarget}. */
export interface CanvasDrill {
  /** The layer the double-click selects. */
  select: string
  /**
   * True when `select` is the pressed LEAF itself: the double-click then goes
   * on to do what a double-click on that layer always did (a text edit, vector
   * edit). False for a container level, where selecting it is all it does.
   */
  thenEdit: boolean
}

/**
 * A double-click on `hitId`, given what its two clicks selected.
 *
 *  - On a CONTAINER level: the layer ONE level below, on the way to the
 *    pressed element — Figma's "select inside", one level per double-click.
 *  - On a LEAF (no children — a run of text, an image, a graphic): straight to
 *    that leaf, then its own edit. A leaf is where a double-click's meaning
 *    lives, and a text three containers deep would otherwise take four
 *    double-clicks to type into.
 *
 * `null` when the clicks already selected the innermost layer — the
 * double-click then means what it always did (open a closed instance, start a
 * text edit, enter vector edit).
 */
export function resolveCanvasDrillTarget(
  tree: NodeTree<PageNode>,
  hitId: string,
  context: CanvasPressContext,
): CanvasDrill | null {
  const leaf = clampToComponentBoundary(tree, hitId, context)
  const current = resolveCanvasPressTarget(tree, hitId, context, { deep: false })
  if (current === leaf) return null
  if ((tree.nodes[leaf]?.children.length ?? 0) === 0) return { select: leaf, thenEdit: true }
  const path = pathTo(tree, leaf)
  const index = path.indexOf(current)
  return index >= 0 && index < path.length - 1 ? { select: path[index + 1]!, thenEdit: false } : null
}

/** What a body drag should carry, decided at `pointerdown`. */
export interface CanvasPressDragPlan {
  /** Node ids the gesture proposes to move, before locked/root filtering. */
  candidateIds: readonly string[]
  /** The layer the press means — the one the ghost names. */
  preferredDraggedId: string
  /** Selected once the press turns into a drag; `null` when it is already selected. */
  selectOnActivate: string | null
}

/**
 * The drag a press on `hitId` would start. Pressing inside the selection drags
 * the WHOLE selection (a multi-select must not collapse to one layer the
 * moment you move it); pressing anywhere else drags the layer the press means,
 * and selects it only once the gesture stops being a click — a press that
 * stays a click is decided on release, by the click path, never here.
 */
export function planCanvasPressDrag(
  tree: NodeTree<PageNode>,
  hitId: string,
  context: CanvasPressContext,
  { deep }: { deep: boolean },
): CanvasPressDragPlan {
  const target = resolveCanvasPressTarget(tree, hitId, context, { deep })
  const inSelection = context.selectedIds.includes(target)
  return {
    candidateIds: inSelection ? context.selectedIds : [target],
    preferredDraggedId: target,
    selectOnActivate: inSelection ? null : target,
  }
}
