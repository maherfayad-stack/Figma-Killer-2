/**
 * selectionStyleCommands — a style write from OUTSIDE the inspector that
 * still lands where the inspector would have put it (P5-E).
 *
 * The keyboard's ⇧A and align, paste style, and the on-canvas padding / gap
 * handles all write a style onto the selection. The inspector decides WHERE
 * such a write goes — the element's inline style, or the one class that
 * already sets the property — through `useSelectionModel` +
 * `useInspectorCommit` (`resolveWriteTarget`, the P1 rule). Those are hooks,
 * because the model needs the frame's computed style and the editor's
 * permissions. A key handler or a pointer gesture is not a component, and a
 * second, hand-written copy of the rule would drift from the first (the audit
 * says so for IX-17 in as many words: "use the inspector's own write-target
 * resolver so the two surfaces agree").
 *
 * So a command is QUEUED here and run by `SelectionStyleCommandHost`, which
 * mounts the real model + commit API only while a command is waiting, runs it
 * in a layout effect, and unmounts again. Idle cost: nothing — no second
 * always-on selection model reading ~100 computed properties on every render.
 * The price is one React commit of latency, which a key press or the release
 * of a drag never notices.
 *
 * A command runs against the selection AS IT IS when the host renders — the
 * same selection the key press or the drag acted on, because nothing between
 * the two can change it.
 */
import { useSyncExternalStore } from 'react'
import type { InspectorCommitApi } from '@site/inspector/commitApi'
import type { SelectionModel } from '@site/inspector/selectionModel'

export type SelectionStyleCommand = (commit: InspectorCommitApi, model: SelectionModel) => void

let queue: readonly SelectionStyleCommand[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Queue `command`; `SelectionStyleCommandHost` runs it on its next commit. */
export function runSelectionStyleCommand(command: SelectionStyleCommand): void {
  queue = [...queue, command]
  notify()
}

/** Drop exactly the commands a host just ran (more may have arrived meanwhile). */
export function settleSelectionStyleCommands(ran: readonly SelectionStyleCommand[]): void {
  queue = queue.filter((command) => !ran.includes(command))
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The commands waiting to run — a stable array reference until the queue changes. */
export function usePendingSelectionStyleCommands(): readonly SelectionStyleCommand[] {
  return useSyncExternalStore(subscribe, () => queue, () => queue)
}

/** Test seam. */
export function resetSelectionStyleCommands(): void {
  queue = []
  notify()
}
