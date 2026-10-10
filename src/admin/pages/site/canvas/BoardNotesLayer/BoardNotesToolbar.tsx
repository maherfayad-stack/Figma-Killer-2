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
 *
 * A new note/doc appears at the centre of the visible viewport, selected, and
 * already in edit mode (`annotationPlacement.ts`). It used to land at a fixed
 * board coordinate — usually off-screen, stacked on the previous one — so the
 * click looked dead and the user's next keystrokes ran tool shortcuts.
 */
import { useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import {
  DEFAULT_DOC_HEIGHT,
  DEFAULT_DOC_WIDTH,
  DEFAULT_NOTE_HEIGHT,
  DEFAULT_NOTE_WIDTH,
} from '@site/store/slices/boardAnnotationActions'
import { Button } from '@ui/components/Button'
import { CommentToolButton } from '../BoardCommentsLayer/CommentToolButton'
import { centredAnnotationPosition, requestAnnotationEdit } from '../annotationPlacement'
import styles from './BoardNotesToolbar.module.css'

export function BoardNotesToolbar() {
  const board = useEditorStore(selectActiveBoard)
  const addNote = useEditorStore((s) => s.addNote)
  const addDoc = useEditorStore((s) => s.addDoc)
  const toolbarRef = useRef<HTMLDivElement>(null)

  if (!board) return null

  const handleAdd = (kind: 'note' | 'doc') => {
    const canvas = toolbarRef.current?.parentElement
    if (!canvas) return
    const { width, height } = canvas.getBoundingClientRect()
    const { zoom, panX, panY } = useEditorStore.getState()
    const size =
      kind === 'note'
        ? { width: DEFAULT_NOTE_WIDTH, height: DEFAULT_NOTE_HEIGHT }
        : { width: DEFAULT_DOC_WIDTH, height: DEFAULT_DOC_HEIGHT }
    const { x, y } = centredAnnotationPosition({
      zoom,
      panX,
      panY,
      viewportWidth: width,
      viewportHeight: height,
      ...size,
      existing: [...board.notes, ...board.docs],
    })
    if (kind === 'note') addNote(x, y)
    else addDoc(x, y)

    // The id is minted inside the store action, so read the board back.
    const after = useEditorStore.getState()
    const active = selectActiveBoard(after)
    const created = kind === 'note' ? active?.notes.at(-1) : active?.docs.at(-1)
    if (!created) return
    requestAnnotationEdit(created.id)
    after.selectAnnotation({ kind, id: created.id })
  }

  return (
    <div ref={toolbarRef} className={styles.toolbar}>
      <Button variant="secondary" size="sm" onClick={() => handleAdd('note')}>
        + Sticky note
      </Button>
      <Button variant="secondary" size="sm" onClick={() => handleAdd('doc')}>
        + Doc
      </Button>
      <CommentToolButton />
    </div>
  )
}
