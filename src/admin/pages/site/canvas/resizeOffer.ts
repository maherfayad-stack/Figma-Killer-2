/**
 * resizeOffer — the one rule for "should this node get drag handles at all?".
 *
 * Pure and separate from `elementResize.ts` (which is geometry) because this
 * is POLICY, and policy that disagrees with the write path is the bug it
 * exists to prevent. Studio's §2 invariant is that an edit surface either
 * writes, refuses with a reason, or is not offered — handles that track the
 * cursor for a whole drag and then snap back are the fourth thing, and the
 * worst one: they look like a write, they update the store, and the user's
 * file never changes.
 *
 * Three independent reasons a resize has nowhere to land:
 *
 *   1. **No element of its own.** A `studio.instance` call site renders as a
 *      React Fragment with zero DOM boxes (`inlineLocalComponents.ts`), so
 *      `RenderedCanvasNodeCache` resolves it to its DESCENDANTS — which is
 *      right for drawing a selection ring around a component and wrong for
 *      sizing, because the box under the handles belongs to a different node.
 *   2. **A display CSS ignores a size on.** `inline`, `contents`, `none`. The
 *      edit lands in the source and changes nothing on screen — a dead
 *      affordance that is harder to spot than a refusal, because it appears
 *      to have worked.
 *   3. **A module that does not own its own `style=""`.** S4: a `pkg.*`
 *      component is an arbitrary third-party package Studio knows nothing
 *      about, and a `studio.instance` renders no element at the call site at
 *      all, so `fsCodemodAdapter.saveSite` emits no `kind:'style'` edit for
 *      either. `canWriteInlineStyleForModule` is the same predicate
 *      `StyleSurface` hides its inline composer behind; the canvas has to
 *      answer the question identically or the two surfaces disagree about the
 *      same node.
 */
import { canWriteInlineStyleForModule } from '@core/page-tree'

/** Outer displays CSS simply ignores `width`/`height` on. */
const UNSIZEABLE_DISPLAYS = new Set(['inline', 'contents', 'none'])

export interface ResizeOfferInput {
  /**
   * The selected node's module, or `null` when the node could not be resolved
   * from the store at all — which is not a case to guess at: with no node
   * there is no way to know whether a write would land, and offering the drag
   * anyway is exactly the failure this module names.
   */
  moduleId: string | null
  /** Whether an element carrying THIS node's `data-node-id` exists in the frame. */
  hasOwnElement: boolean
  /**
   * The computed `display` of the node's PRESENTED element — which for an
   * `alm.*` node is the design-system component one level below the
   * `display: contents` host carrying the node id (`presentedElementForNode`).
   * Reading the host's own display here would refuse every design-system
   * component on rule 2, since `contents` takes no size. Empty when there is
   * no element.
   */
  display: string
}

/** True when a drag on this node has an honest target in the user's source. */
export function canOfferResize({ moduleId, hasOwnElement, display }: ResizeOfferInput): boolean {
  if (moduleId === null || !canWriteInlineStyleForModule(moduleId)) return false
  if (!hasOwnElement) return false
  return !UNSIZEABLE_DISPLAYS.has(display)
}
