/**
 * BoardDocsLayer — markdown documentation-block overlay, mounted right after
 * `BoardNotesLayer` inside `CanvasTransformLayer` so it inherits the canvas
 * pan/zoom transform.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio mode
 * (`?studio`) or before boards have loaded, so it is always safe to mount.
 * Because it lives inside the transform layer, each doc block positions with
 * plain `left`/`top` in BOARD coordinates — no manual pan/zoom math here.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { DocBlockView } from './DocBlockView'
import styles from './BoardDocsLayer.module.css'

export function BoardDocsLayer() {
  const board = useEditorStore(selectActiveBoard)

  if (!board) return null

  return (
    <div className={styles.layer} data-testid="board-docs-layer">
      {board.docs.map((doc) => (
        <DocBlockView key={doc.id} doc={doc} />
      ))}
    </div>
  )
}
