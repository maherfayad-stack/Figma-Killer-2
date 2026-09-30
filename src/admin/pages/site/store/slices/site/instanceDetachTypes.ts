/**
 * instanceDetachTypes — the store surface of P5-C's ONE detach action
 * (`instanceActions.ts`), in its own module so `SiteSlice` can extend it
 * without `types.ts` (at its size ceiling) growing a section, and without a
 * type cycle between the two.
 */

/**
 * What one `detachInstances` call came to. `handed-off`: a nested instance's
 * detach went to OD-7's "this instance only" path (`instanceOnlyGesture.ts`),
 * which reports its own outcome.
 */
export type DetachInstancesOutcome = 'detached' | 'refused' | 'cancelled' | 'nothing' | 'handed-off'

/** The pre-commit confirm `DetachConfirmDialog` shows: only ever opened when a detach LOSES something. */
export interface InstanceDetachConfirmState {
  title: string
  /** One sentence per thing that is lost — other states, every row, a moved hook. */
  losses: string[]
}

export interface InstanceDetachSlice {
  /** The open pre-commit confirm, or `null`. */
  instanceDetachConfirm: InstanceDetachConfirmState | null
  /**
   * The Detach verb — the Component section's button, both context menus,
   * ⌘⌥B / Ctrl+Alt+B and the refusal remedy all call this and nothing else.
   * Non-instances in `nodeIds` are ignored. See `instanceActions.ts`.
   */
  detachInstances: (nodeIds: readonly string[]) => Promise<DetachInstancesOutcome>
  /** Answer the open confirm: `true` writes the held detach, `false` leaves the file as it is. */
  resolveInstanceDetachConfirm: (confirmed: boolean) => void
}
