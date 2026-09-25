/**
 * studioBatchUndoJournal — what one `/save` batch owes the undo journal
 * (`studio/undoJournal.ts`, P3-F): the pre-image of a one-shot write before
 * it runs, and the `restore` edit that puts it back.
 *
 * Split out of `studioWriteback.ts` (module-size ceiling) along the line the
 * journal draws: the batch engine decides WHAT runs; this decides what the
 * journal records about it and when a `restore` may run at all.
 *
 * ## Which writes are journaled
 *
 * {@link JOURNALED_KINDS}: the one-shot rewrites whose undo no other edit kind
 * can express — `delete`, `detach`, `swap`, and `promote-component` (extract a
 * subtree into a new component). A batch holding any of them records ONE
 * entry covering every file the batch changed, so one gesture is one token,
 * however many elements a multi-select delete removed and across however
 * many files.
 *
 * Only a batch run with `journal: true` records — the editor's `/save` route.
 * An agent's `studio_apply_edits` batch has its own undo (the turn
 * checkpoints), so it neither pays for a pre-image nor may post a `restore`.
 *
 * ## `restore` runs alone
 *
 * A restore writes whole files back. Any other edit in the same batch was
 * planned against the files as they are NOW, so running both would write one
 * of them into bytes it was never aimed at. A `restore` in a batch of more
 * than one edit is refused by name, before anything runs.
 */
import { join } from 'node:path'
import { refusalFor, StudioEditRefusalError } from './studioEditRefusals'
import type { StudioEdit, StudioEditApplyOutcome, StudioEditBatchOptions, StudioEditRefusal } from './studioEditSchemas'
import { captureUndoPreImage, recordUndoJournal, restoreUndoJournal, undoJournalFiles } from './studio/undoJournal'

/** The kinds a journaled batch records a pre-image for. */
const JOURNALED_KINDS = new Set<StudioEdit['kind']>(['delete', 'detach', 'swap', 'promote-component'])

export interface BatchUndoJournal {
  /** A `restore` that may not run in this batch, as its refusal — `null` for every other edit. */
  refuse: (edit: StudioEdit) => StudioEditRefusal | null
  /** After the batch: record what it changed, and return the token — `undefined` when nothing was recorded. */
  commit: (written: number, createdFiles: readonly string[]) => string | undefined
}

/**
 * Open the journal for one batch. Call it BEFORE the first edit runs:
 * `touchedFiles` is read now, and a `restore`'s own files are ADDED to it so
 * the batch's line-count check and its `touchedFiles` report cover the files
 * the restore is about to rewrite.
 */
export function openBatchUndoJournal(
  dir: string,
  edits: readonly StudioEdit[],
  touchedFiles: Set<string>,
  options: StudioEditBatchOptions,
): BatchUndoJournal {
  const journaling = options.journal === true
  for (const edit of edits) {
    if (edit.kind === 'restore' && journaling) for (const file of undoJournalFiles(dir, edit.token)) touchedFiles.add(file)
  }
  const preImage = journaling && edits.some((edit) => JOURNALED_KINDS.has(edit.kind)) ? captureUndoPreImage(touchedFiles) : null

  return {
    refuse: (edit) => {
      if (edit.kind !== 'restore') return null
      if (!journaling) {
        return refusalFor(edit, 'restore-editor-only', 'Only the editor’s own undo can restore a change Studio journaled. Nothing was written.')
      }
      if (edits.length > 1) {
        return refusalFor(edit, 'restore-not-alone', 'An undo that restores files must be the only edit in its request. Nothing was written.')
      }
      return null
    },
    commit: (written, createdFiles) => {
      if (!preImage || written === 0) return undefined
      return recordUndoJournal(dir, preImage, createdFiles.map((rel) => join(dir, ...rel.split('/')))) ?? undefined
    },
  }
}

/** Apply one `restore` edit — every file its entry names, or none. Refusals throw, like every other kind's. */
export function applyRestoreEdit(dir: string, edit: Extract<StudioEdit, { kind: 'restore' }>): StudioEditApplyOutcome {
  const result = restoreUndoJournal(dir, edit.token)
  if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
  return { applied: true }
}
