/**
 * BoardNotesLayer — sticky-notes overlay, mounted as the last child inside
 * `CanvasTransformLayer` so it inherits the canvas pan/zoom transform.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio mode
 * (`?studio`) or before boards have loaded, so it is always safe to mount.
 * Because it lives inside the transform layer, each note positions with
 * plain `left`/`top` in BOARD coordinates — no manual pan/zoom math here.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { StickyNoteView } from './StickyNoteView'
import styles from './BoardNotesLayer.module.css'

export function BoardNotesLayer() {
  const board = useEditorStore(selectActiveBoard)

  if (!board) return null

  return (
    <div className={styles.layer} data-testid="board-notes-layer">
      {board.notes.map((note) => (
        <StickyNoteView key={note.id} note={note} />
      ))}
    </div>
  )
}
