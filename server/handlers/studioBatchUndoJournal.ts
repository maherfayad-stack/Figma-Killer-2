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
 * {@link isJournaled}: the one-shot rewrites whose undo no other edit kind
 * can express — `delete`, `detach`, `expose-prop` (P5-C: a component AND its
 * call site), `swap`, `promote-component` (extract a subtree into a new
 * component), a `list-item` remove (OD-8: a `.map`
 * row's delete cuts array elements whose bytes no op carries back), a
 * `transplant` that MOVES (a cross-frame drag: two files, one pruned import),
 * a same-file `move` / `reparent` (the splice leaves a blank line and an
 * indentation no inverse move reproduces),
 * a free-canvas `canvas-layer-lift` / `canvas-layer-place` that MOVES (the page
 * and the layer module), and an `insert` that asked for an exact undo
 * (`exactUndo`, also asked of a `duplicate` and a copying `transplant`: it writes into a childless parent). A batch holding any of them records ONE
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
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cssEditTargetFile } from './studioCssWriteback'
import { refusalFor, StudioEditRefusalError } from './studioEditRefusals'
import type { StudioEdit, StudioEditApplyOutcome, StudioEditBatchOptions, StudioEditRefusal } from './studioEditSchemas'
import { captureUndoPreImage, recordUndoJournal, restoreUndoJournal, undoJournalFiles } from './studio/undoJournal'

/** The kinds a journaled batch records a pre-image for. */
const JOURNALED_KINDS = new Set<StudioEdit['kind']>(['delete', 'detach', 'expose-prop', 'swap', 'promote-component', 'move', 'reparent'])

export function isJournaled(edit: StudioEdit): boolean {
  return (
    JOURNALED_KINDS.has(edit.kind) ||
    (edit.kind === 'list-item' && edit.op.kind === 'remove') ||
    // A cross-file MOVE (a COPY is taken back by deleting what it made). The
    // move cuts markup from one file, prunes the import only that markup used,
    // and carries imports into the other — every `line:col` below the cut in
    // BOTH files shifts, including the container the element left, which is
    // the only place an inverse `transplant` could put it back. No id recorded
    // before the write survives it; the pre-image does, and restoring it is
    // also byte-exact (blank lines, import order and all).
    (edit.kind === 'transplant' && (edit.copy !== true || edit.exactUndo === true)) ||
    // The same shape on the free canvas: a lift cuts the element out of the
    // page and creates the layer's module, a place writes the root into the
    // page and removes the module. Either way every id below the cut shifts
    // (a pruned import, a collapsed blank line) and the module is a whole file
    // — only the pre-image names both ends. A COPY is taken back by deleting
    // the layer it made, or the element it wrote: ids the write itself reported.
    ((edit.kind === 'canvas-layer-lift' || edit.kind === 'canvas-layer-place') && edit.copy !== true) ||
    // An insert into a childless parent expands `<X />` to `<X>…</X>`; deleting
    // the insert leaves `<X>` + newline + `</X>`, which is not what was there.
    // The client asks for the pre-image exactly when the parent had no children.
    ((edit.kind === 'insert' || edit.kind === 'duplicate') && edit.exactUndo === true) ||
    // CT-5 - a restyle (apply / create / detach a text or effect style) is a
    // class edit, an inline-style strip and, for a create, a new rule in a
    // stylesheet - possibly a brand-new one. Only the pre-image takes all of
    // that back byte for byte (the class token's `className` may have been
    // created, wrapped or emptied; the new rule's block is a CST insertion).
    isRestyleEdit(edit)
  )
}

/** CT-5 - the refusal reason of an edit that wrote, then was taken back because another edit of its restyle batch refused. */
export const RESTYLE_ROLLED_BACK_REASON = 'restyle-rolled-back'

/** CT-5 - the class edit that marks its whole batch as one restyle gesture. */
export function isRestyleEdit(edit: StudioEdit): boolean {
  return edit.kind === 'class' && edit.restyle === true
}

export interface BatchUndoJournal {
  /** A `restore` that may not run in this batch, as its refusal — `null` for every other edit. */
  refuse: (edit: StudioEdit) => StudioEditRefusal | null
  /**
   * CT-5 - a restyle batch is ALL OR NOTHING. Called after the loop with
   * whether any edit refused and the workspace-relative files the batch
   * created: when it is a restyle that refused, every file goes back to the
   * pre-image, every created file is removed, and this returns `true` - the
   * caller reports `written: 0`. Any other batch returns `false` and is left
   * alone.
   */
  rollbackRestyle: (refused: boolean, createdFiles: readonly string[]) => boolean
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
  const restyling = edits.some(isRestyleEdit)
  // A restyle needs its pre-image for the rollback even when nothing is journaled (an agent's batch).
  // A CSS edit names a FILE, not a `line:col`, so its stylesheet is not in
  // `touchedFiles` (and must stay out of it: that set drives `shifted`).
  const cssFiles = edits.flatMap((edit) => {
    const file = edit.kind === 'css' ? cssEditTargetFile(dir, edit) : null
    return file === null ? [] : [file]
  })
  const preImage =
    (journaling && edits.some(isJournaled)) || restyling ? captureUndoPreImage([...touchedFiles, ...cssFiles]) : null
  const absolute = (rel: string): string => join(dir, ...rel.split('/'))

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
    rollbackRestyle: (refused, createdFiles) => {
      if (!restyling || !refused || !preImage) return false
      for (const [file, bytes] of preImage) {
        if (bytes === null) rmSync(file, { force: true })
        else writeFileSync(file, bytes)
      }
      for (const rel of createdFiles) {
        const file = absolute(rel)
        if (existsSync(file)) rmSync(file, { force: true })
      }
      return true
    },
    commit: (written, createdFiles) => {
      if (!journaling || !preImage || written === 0) return undefined
      return recordUndoJournal(dir, preImage, createdFiles.map(absolute)) ?? undefined
    },
  }
}

/** Apply one `restore` edit — every file its entry names, or none. Refusals throw, like every other kind's. */
export function applyRestoreEdit(dir: string, edit: Extract<StudioEdit, { kind: 'restore' }>): StudioEditApplyOutcome {
  const result = restoreUndoJournal(dir, edit.token)
  if (!result.ok) throw new StudioEditRefusalError(result.reason, result.message)
  return { applied: true }
}
