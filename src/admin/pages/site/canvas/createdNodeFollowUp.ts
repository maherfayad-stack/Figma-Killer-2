/**
 * createdNodeFollowUp — "when the element this gesture is about to create
 * shows up, do X to it" (P5-E).
 *
 * Two gestures need it: the text tool (T) opens the new text for typing
 * (IX-12), and ⇧A on several layers groups them and then lays the group out
 * (IX-10). On a studio tree neither can act at once: an insert or a group is
 * an async SOURCE write, and the new element's id is the `line:col` the
 * codemod produces, which exists only once the resync lands. `store-13`
 * already selects what a write created the moment the resync brings it in
 * (`siteReloadApply.ts`), so the follow-up keys off THAT: the first time the
 * selection becomes a single node that did not exist when the gesture ran,
 * the follow-up runs on it. A CMS tree creates the node synchronously and
 * selects it at once, so the same rule covers both.
 *
 * Bounded twice, so it can never fire on something the user did later:
 *   - it expires after {@link FOLLOW_UP_WINDOW_MS};
 *   - it is dropped the moment the selection lands on a node that ALREADY
 *     existed (the user clicked something else) or the write is refused
 *     (nothing new ever arrives before the window closes).
 */
import { useEffect } from 'react'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'

/** Long enough for a slow source write + resync; short enough that a stale arming cannot surprise anyone. */
export const FOLLOW_UP_WINDOW_MS = 8_000

interface PendingFollowUp {
  /**
   * Every node id at arming time — anything in it is not "new". A COPY: the
   * store's `_nodeIdToPageIds` is maintained in place (`nodeIndex.ts`), so a
   * reference to it would already contain the new node by the time it lands.
   * One pass over the ids per gesture, never per render.
   */
  existing: ReadonlySet<string>
  expiresAt: number
  run: (nodeId: string) => void
}

let pending: PendingFollowUp | null = null

/** Arm a follow-up for the node the gesture that is about to run creates. Replaces any earlier one. */
export function armCreatedNodeFollowUp(run: (nodeId: string) => void, now: number = Date.now()): void {
  const state = useEditorStore.getState()
  // The page index, plus the active tree's own ids: a Visual Component's
  // nodes are not in the page index.
  const existing = new Set(state._nodeIdToPageIds.keys())
  for (const id of Object.keys(selectActiveCanvasPage(state)?.nodes ?? {})) existing.add(id)
  pending = { existing, expiresAt: now + FOLLOW_UP_WINDOW_MS, run }
}

export function cancelCreatedNodeFollowUp(): void {
  pending = null
}

/**
 * Offer the current selection to the armed follow-up. Exported for the hook
 * below and for tests; returns whether the follow-up ran.
 */
export function offerSelectionToFollowUp(selectedNodeIds: readonly string[], now: number = Date.now()): boolean {
  const current = pending
  if (!current) return false
  if (now > current.expiresAt) {
    pending = null
    return false
  }
  if (selectedNodeIds.length !== 1) return false
  const [nodeId] = selectedNodeIds as [string]
  // The selection moved to something that was already there: the user did
  // something else, and the follow-up belongs to nothing any more.
  if (current.existing.has(nodeId)) {
    pending = null
    return false
  }
  pending = null
  current.run(nodeId)
  return true
}

/**
 * Mounted once by `CanvasRoot`: watches the selection and hands each change to
 * the armed follow-up. A plain store subscription — no render, and nothing at
 * all happens while no follow-up is armed.
 */
export function useCreatedNodeFollowUp(): void {
  useEffect(
    () =>
      useEditorStore.subscribe((state, previous) => {
        if (!pending || state.selectedNodeIds === previous.selectedNodeIds) return
        offerSelectionToFollowUp(state.selectedNodeIds)
      }),
    [],
  )
}
