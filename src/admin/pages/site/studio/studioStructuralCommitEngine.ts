/**
 * studioStructuralCommitEngine — the one body every structural commit runs
 * (`commitStructural`): flush the autosave, post the batch, report what the
 * source refused, settle or roll back what the gesture already did, and re-sync
 * the board with disk only when a write landed.
 *
 * Split out of `studioStructuralCommits.ts` (P5-B, at the module-size gate's
 * prompting) along the line that module's own doc already drew: the VERBS
 * (move, insert, wrap, …) say WHAT to post and what its ⌘Z is; this engine is
 * HOW every one of them is posted. One reload contract, one refusal channel.
 */
import { pushToast } from '@ui/components/Toast'
import { flushEditorSave } from '@site/hooks/editorSaveRef'
import { settleOrRollbackOptimistic, type OptimisticPreviewHandle } from '@site/store/slices/site/structuralOptimism'
import type { StructuralCommitRollback } from '@site/store/slices/site/structuralCommitRollback'
import { isUnreachableFailure } from '@core/http'
import type { PendingStructuralHistory } from './pendingStructuralOutcome'
import { beginStructuralCommit, endStructuralCommit } from './structuralCommitQueue'
import {
  resolveStructuralInverse,
  structuralEditNodeIds,
  type StructuralEditPayload,
  type StructuralInverseTemplate,
  type StructuralWriteOutcome,
} from './structuralUndoPlan'
import { resyncBoardAfterWrite } from './studioBoardResync'
import { postEditsRetryingUnreachable } from './structuralWriteRetry'
import { captureIdentities, type IdentityCapture } from './sourceIdentity'
import { elementMovedNodeIds, replanAfterElementMoved, warnElementMoved } from './elementMovedRecovery'

/**
 * What a structural commit does beyond posting: what it means for the undo
 * stack, and what it takes back if it does not land.
 *
 * P3-A — no commit announces a success. The canvas already shows the result
 * (an optimistic preview, or the moved/deleted tree), and the resync selects
 * what the gesture made; a "Duplicated" card on top of the duplicate is noise
 * that says the same thing twice (02 §2a "Inserted / Placed").
 */
export interface StructuralCommitOptions {
  /**
   * `store-14` — this gesture's ⌘Z, as a template the write's own answer fills
   * in (`structuralUndoPlan.ts`). Omitted by `move`/`reparent`, whose undo
   * already rides the tree-mutation stack (`structuralHistory.ts`), and by
   * `delete`, which uses `fill` below instead — its own tree mutation already
   * pushed an entry, and TAGGED it with this same template, before the commit
   * that reveals the answer even started.
   */
  undo?: { label: string; template: StructuralInverseTemplate }
  /**
   * `store-15` — set only by `delete`. Its tree mutation (and history entry)
   * already ran, synchronously, BEFORE this commit — `deleteNodesAction.ts`
   * tagged it with the gesture's `label`/`forward`/`inverseTemplate` already
   * filled in. This asks the resync to fill in just `inverse`, the one field
   * that answer could not know yet, on that SAME entry.
   */
  fill?: boolean
  /**
   * Set when this commit IS an undo or a redo re-issuing a stored entry. The
   * stack bookkeeping happened in `undoRedoActions.ts`; this only asks the
   * resync to re-resolve that entry's inverse against the ids the re-issue
   * reported.
   */
  reissue?: 'undo' | 'redo'
  optimistic?: OptimisticPreviewHandle // `perf-10` — local preview, settled/rolled back in `commitStructuralBody`.
  /**
   * ERR-6 — what a move/delete already did to the tree, or what an undo/redo
   * already did to the stack, taken back if this write does not land
   * (`structuralCommitRollback.ts`). Settled or rolled back exactly once.
   */
  rollback?: StructuralCommitRollback
  replanned?: true // P1-A — this post IS the one silent re-plan after `element-moved`; a second one warns instead.
}

/**
 * Shared body of the structural commits: flush any pending debounced save,
 * post, report what the source refused, and re-sync the board with disk when
 * (and only when) a write actually landed.
 *
 * `STUDIO-FIGMA-PARITY-PLAN.md` 0.2 (audit E2) — two fixes, both applied here:
 *
 *   1. Reload only when a write landed (trap #5, the same `written > 0` gate
 *      `fsCodemodAdapter.saveSite` uses). It used to fire from a `finally` on
 *      every outcome, and reloading an unchanged disk replaced the user's
 *      optimistic edit with the pre-edit source. A move/delete that did NOT
 *      land is taken back instead, through `options.rollback` (ERR-6,
 *      `structuralCommitRollback.ts`).
 *   2. Before posting, flush and AWAIT any edit still inside the autosave
 *      debounce, so a value edit made moments before this gesture is written
 *      (and its diff baseline advanced) before a re-parse could discard it
 *      or aim it at now-stale ids. A flush failure is logged and the commit
 *      proceeds — the save chip already surfaces that failure.
 *
 * Track C5 changed only what a "reload" does once the gate above says one
 * should happen (`studioBoardResync.ts`); every gate here is unchanged.
 *
 * P1-A: every commit posts the identity of each id it names, captured when the
 * gesture was made, and an `element-moved` refusal is re-planned once, silently.
 *
 * ERR-6: a write that gets no answer is retried on a short ladder first
 * (`structuralWriteRetry.ts`). A write that does not land in the end — refused
 * outright, re-plan exhausted, or still unreachable — settles nothing: its
 * `rollback` takes back what the gesture already did, and the user sees ONE
 * toast for it however many edits the batch held.
 */
export async function commitStructural(
  edits: readonly StructuralEditPayload[],
  refusalTitle: string,
  options: StructuralCommitOptions = {},
): Promise<void> {
  // Held for the whole body, including the resync at the bottom — see
  // `structuralCommitQueue.ts` for why the window has to extend past the POST
  // itself, and what happens to a gesture that arrives inside it.
  // P1-A — who every id names, captured at the gesture's own moment: before the
  // flush below, or a commit ahead in the queue, can renumber the file.
  const identities = captureIdentities(edits.flatMap((edit) => structuralEditNodeIds(edit)))
  beginStructuralCommit()
  try {
    await commitStructuralBody(edits, refusalTitle, options, identities)
  } finally {
    endStructuralCommit()
  }
}

async function commitStructuralBody(
  edits: readonly StructuralEditPayload[],
  refusalTitle: string,
  options: StructuralCommitOptions,
  identities: IdentityCapture,
): Promise<void> {
  try {
    await flushEditorSave()
  } catch (err) {
    console.error('[studioSaveRequests] pre-structural-edit save flush failed:', err)
  }

  try {
    const result = await postEditsRetryingUnreachable(edits, identities)
    // `element-moved` is never toasted here — it is recovered from below.
    const moved = elementMovedNodeIds(result.refusals)
    const refusals = (result.refusals ?? []).filter((refusal) => !moved.has(refusal.nodeId))
    const willReload = result.written > 0
    // P1-A — an `element-moved` miss is re-planned below, and the re-plan owns
    // the rollback when nothing else landed; every other outcome is known now.
    const replanning = moved.size > 0 && !options.replanned && !willReload
    // `perf-10`; ERR-22 — what the write created is what a Delete queued on
    // the preview acts on once this commit ends.
    settleOrRollbackOptimistic(options.optimistic, willReload ? 'settle' : 'rollback', result.createdNodeIds ?? [])
    if (willReload) options.rollback?.settle()
    else if (!replanning) options.rollback?.rollback('refused')
    // ERR-6 — one gesture, one toast: the first reason, however many edits the
    // batch held. A partial refusal still says so; the resync shows the rest.
    // WB-13 — a warning: the gesture was taken back and the file is exactly
    // as it was. Nothing broke; the editor declined a write it could not make
    // honestly. (WB-12 made every refusal named, so there is no "skip with no
    // reason" left to report here.)
    const [firstRefusal] = refusals
    if (firstRefusal) {
      const more = refusals.length > 1 ? ` (${refusals.length - 1} more like this.)` : ''
      pushToast({ kind: 'warning', title: refusalTitle, body: `${firstRefusal.message}${more}`, location: 'site-editor' })
    }
    // trap #5 — reload only when a write actually landed (`rollback` above
    // takes a refused one back). Track C5: `resyncBoardAfterWrite` is narrow
    // when it can prove it. `store-13`/`store-14`: what this write CREATED and
    // MOVED rides the resync itself (ERR-10, `pendingStructuralOutcome.ts`),
    // applied by the re-read this write triggers and no other; the await
    // covers a full reload too, so the queue re-plans against these ids.
    if (willReload) {
      const outcome: StructuralWriteOutcome = {
        createdNodeIds: result.createdNodeIds ?? [],
        relocatedNodeIds: result.relocatedNodeIds ?? [],
        removed: result.removed ?? [],
        prunedImports: result.prunedImports ?? [],
      }
      await resyncBoardAfterWrite(result.touchedFiles ?? [], {
        structuralOutcome: {
          selectNodeIds: [...outcome.createdNodeIds, ...outcome.relocatedNodeIds],
          history: resolvePendingHistory(edits, options, outcome),
        },
      })
    }
    // P1-A — the file changed under the board. Re-read it and re-plan ONCE,
    // silently (`elementMovedRecovery.ts`); only a second miss says anything.
    // The re-plan inherits `rollback` only when this pass settled nothing.
    if (moved.size > 0) {
      const movedEdits = edits.filter((edit) => moved.has(edit.nodeId))
      const replan = options.replanned ? null : await replanAfterElementMoved(movedEdits, identities, result.touchedFiles ?? [])
      const carried = replanning ? options.rollback : undefined
      if (replan) {
        await commitStructuralBody(replan.edits, refusalTitle, { ...options, optimistic: undefined, rollback: carried, replanned: true }, replan.identities)
      } else {
        carried?.rollback('refused')
        warnElementMoved(moved)
      }
    }
  } catch (err) {
    // Fire-and-forget from the store's mutation guard, so this is the only
    // place the failure can be reported. No response was ever obtained, so
    // there is no `written` count to check — the safe assumption after a
    // failed request is "disk is unchanged," which means no reload either
    // (see this function's doc for why an unconditional reload here was the
    // bug, not the fix) — and the gesture is taken back (ERR-6). Both calls
    // are no-ops if the write had already settled before something later
    // (the resync) threw.
    settleOrRollbackOptimistic(options.optimistic, 'rollback') // `perf-10`
    options.rollback?.rollback(isUnreachableFailure(err) ? 'unreachable' : 'refused')
    console.error('[studioSaveRequests] structural edit failed:', err)
    // A warning, for the same reason as a refusal: the retry ladder has run
    // out (`structuralWriteRetry.ts`), the gesture is taken back, and the
    // files are unchanged — the board and disk agree again.
    pushToast({
      kind: 'warning',
      title: refusalTitle,
      body: isUnreachableFailure(err)
        ? 'Studio could not reach your project, so the change was taken back. Nothing was written.'
        : 'The change could not be written to your project, so it was taken back. Nothing was written.',
      location: 'site-editor',
    })
  }
}

/**
 * What this landed write means for the undo stack: a new entry, a FILL of the
 * entry `delete`'s own tree mutation already tagged, a refresh of the one an
 * undo/redo just moved, or nothing at all for the gestures (`move`/`reparent`)
 * whose undo lives entirely on the tree-mutation stack.
 */
function resolvePendingHistory(
  edits: readonly StructuralEditPayload[],
  options: StructuralCommitOptions,
  outcome: StructuralWriteOutcome,
): PendingStructuralHistory | null {
  if (options.reissue) return { kind: 'refresh', direction: options.reissue, outcome }
  if (options.fill) return { kind: 'fill', outcome }
  if (!options.undo) return null
  return {
    kind: 'push',
    gesture: {
      label: options.undo.label,
      // Copied, not aliased: the entry outlives this call, and the array it
      // holds has to be a plain mutable one the store's Mutative draft can
      // carry (see `StructuralSourceGesture`).
      forward: [...edits],
      inverseTemplate: options.undo.template,
      inverse: resolveStructuralInverse(options.undo.template, outcome),
    },
  }
}
