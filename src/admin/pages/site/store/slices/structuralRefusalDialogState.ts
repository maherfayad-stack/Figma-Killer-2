/**
 * The shape `RefusalDialog` renders, and the two closures that reach it.
 *
 * Its own module rather than a block inside `uiSlice.ts` because it is not
 * really UI STATE — it is the far end of a store action's refusal, carrying
 * live handlers the gesture that refused built and nothing else can rebuild.
 * `uiSlice` holds the field; this holds the contract, and three surfaces
 * outside the slice (`refusalToasts.ts` and two suites) consume it without
 * needing the slice at all.
 */
import type { EditConstraint } from '@core/page-tree'

/**
 * A refused structural gesture (move/delete/insert/duplicate/wrap) that has
 * at least one runnable remedy — `RefusalDialog` (R2, `store-10`) renders this
 * as a modal instead of the plain toast `presentStructuralRefusal` still uses
 * for a terminal refusal (`constraint.actions.length === 0`).
 *
 * It is store state, not component state: the gesture that produced it can
 * come from anywhere in the store's own action layer (Delete key, a
 * layers-tree drag, a context menu, spotlight) with no JSX render tree to hand
 * the constraint to — the same reason `pushToast` is a global bus.
 */
export interface StructuralRefusalDialogState {
  /** One of `STRUCTURAL_REFUSAL_TITLE`'s values — which gesture this refusal answers. */
  title: string
  constraint: EditConstraint
  /** The node the refusal is about, when the plan had one in hand. */
  nodeId?: string
  /**
   * Re-run the gesture this refusal blocked, against the node that replaces
   * `nodeId` once a detach/extract's board reload lands. Present only for the
   * two remedies that invalidate `nodeId` itself (`detach` / `extract`) —
   * every other runnable remedy (`edit-component`, `jump-to-source`,
   * `edit-array`) just opens a file and needs no re-issue.
   */
  retry?: (newNodeId: string) => void
  /**
   * D2 G3 — run the refused cross-frame drop again as a COPY.
   *
   * A closure rather than an id because the gesture's destination (which page,
   * which container, which index) exists nowhere else by the time the dialog
   * is open: the drag session was torn down at `pointerup`, and the store
   * action that refused is the last thing holding it. Present only when
   * `planSourceTransplant` established that the copy would actually be allowed
   * — see `duplicate-into-frame` in `editConstraint.ts`.
   */
  duplicateIntoFrame?: () => void
}
