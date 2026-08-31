/**
 * BoardNotesToolbar — floating "+ Sticky note" / "+ Doc" affordances.
 *
 * Mounted as an untransformed sibling of `CanvasTransformLayer` in
 * `CanvasRoot` (like `PluginCanvasOverlayLayer`), so it stays fixed in the
 * canvas viewport regardless of pan/zoom — a transformed child would scale
 * with the canvas, which a toolbar button must not do.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio mode or
 * before boards have loaded.
 *
 * One toolbar hosts all three affordances rather than mounting a second one
 * per kind — keeps this floating chrome to a single compact strip.
 *
 * The comment tool sits here with the note and doc buttons because from the
 * reviewer's side they are the same gesture: put something on the board that
 * is not part of the design. It differs in being MODAL — it arms a tool rather
 * than immediately creating something — which is why it owns its own pressed
 * state and the `C` shortcut (`CommentToolButton`).
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { Button } from '@ui/components/Button'
import { CommentToolButton } from '../BoardCommentsLayer/CommentToolButton'
import styles from './BoardNotesToolbar.module.css'

/** New notes/docs cascade diagonally so repeated adds don't stack exactly on top of each other. */
const CASCADE_BASE = 40
const CASCADE_STEP = 24

export function BoardNotesToolbar() {
  const board = useEditorStore(selectActiveBoard)
  const addNote = useEditorStore((s) => s.addNote)
  const addDoc = useEditorStore((s) => s.addDoc)

  if (!board) return null

  const handleAddNote = () => {
    const n = board.notes.length
    addNote(CASCADE_BASE + n * CASCADE_STEP, CASCADE_BASE + n * CASCADE_STEP)
  }

  const handleAddDoc = () => {
    const n = board.docs.length
    addDoc(CASCADE_BASE + n * CASCADE_STEP, CASCADE_BASE + n * CASCADE_STEP)
  }

  return (
    <div className={styles.toolbar}>
      <Button variant="secondary" size="sm" onClick={handleAddNote}>
        + Sticky note
      </Button>
      <Button variant="secondary" size="sm" onClick={handleAddDoc}>
        + Doc
      </Button>
      <CommentToolButton />
    </div>
  )
}
