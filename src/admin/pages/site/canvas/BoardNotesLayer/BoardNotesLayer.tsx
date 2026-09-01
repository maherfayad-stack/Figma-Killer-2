/**
 * BoardNotesLayer — sticky-notes overlay, mounted as the last child inside
 * `CanvasTransformLayer` so it inherits the canvas pan/zoom transform.
 *
 * Self-gates on `selectHasActiveBoard`: renders nothing before boards have
 * loaded, so it is always safe to mount.
 * Because it lives inside the transform layer, each note positions with
 * plain `left`/`top` in BOARD coordinates — no manual pan/zoom math here.
 *
 * Subscribes to `board.notes` alone (`selectActiveBoardNotes`), not the
 * whole `Board` — a frame drag or a guide edit changes `Board`'s reference
 * (every board-mutating transform in `boardsModel.ts` copy-on-writes the
 * whole object) but reuses this layer's `notes` array untouched, so this
 * layer only re-renders on a write that actually touches a note. See
 * `boardSlice.ts`'s doc on the four per-collection selectors.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardNotes, selectHasActiveBoard } from '@site/store/slices/boardSelectors'
import { StickyNoteView } from './StickyNoteView'
import styles from './BoardNotesLayer.module.css'

export function BoardNotesLayer() {
  const hasActiveBoard = useEditorStore(selectHasActiveBoard)
  const notes = useEditorStore(selectActiveBoardNotes)

  if (!hasActiveBoard) return null

  return (
    <div className={styles.layer} data-testid="board-notes-layer">
      {notes.map((note) => (
        <StickyNoteView key={note.id} note={note} />
      ))}
    </div>
  )
}
