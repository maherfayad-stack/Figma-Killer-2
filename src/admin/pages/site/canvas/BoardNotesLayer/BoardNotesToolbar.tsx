/**
 * BoardNotesToolbar — floating "+ Sticky note" affordance.
 *
 * Mounted as an untransformed sibling of `CanvasTransformLayer` in
 * `CanvasRoot` (like `PluginCanvasOverlayLayer`), so it stays fixed in the
 * canvas viewport regardless of pan/zoom — a transformed child would scale
 * with the canvas, which a toolbar button must not do.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio mode or
 * before boards have loaded.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { Button } from '@ui/components/Button'
import styles from './BoardNotesToolbar.module.css'

/** New notes cascade diagonally so repeated adds don't stack exactly on top of each other. */
const CASCADE_BASE = 40
const CASCADE_STEP = 24

export function BoardNotesToolbar() {
  const board = useEditorStore(selectActiveBoard)
  const addNote = useEditorStore((s) => s.addNote)

  if (!board) return null

  const handleAddNote = () => {
    const n = board.notes.length
    addNote(CASCADE_BASE + n * CASCADE_STEP, CASCADE_BASE + n * CASCADE_STEP)
  }

  return (
    <div className={styles.toolbar}>
      <Button variant="secondary" size="sm" onClick={handleAddNote}>
        + Sticky note
      </Button>
    </div>
  )
}
