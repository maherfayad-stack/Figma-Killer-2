/**
 * BoardDocsLayer — markdown documentation-block overlay, mounted right after
 * `BoardNotesLayer` inside `CanvasTransformLayer` so it inherits the canvas
 * pan/zoom transform.
 *
 * Self-gates on `selectHasActiveBoard`: renders nothing outside studio mode
 * (`?studio`) or before boards have loaded, so it is always safe to mount.
 * Because it lives inside the transform layer, each doc block positions with
 * plain `left`/`top` in BOARD coordinates — no manual pan/zoom math here.
 *
 * Subscribes to `board.docs` alone (`selectActiveBoardDocs`), not the whole
 * `Board` — see `BoardNotesLayer.tsx`'s identical note on why, and
 * `boardSlice.ts`'s doc on the four per-collection selectors.
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardDocs, selectHasActiveBoard } from '@site/store/slices/boardSelectors'
import { DocBlockView } from './DocBlockView'
import styles from './BoardDocsLayer.module.css'

export function BoardDocsLayer() {
  const hasActiveBoard = useEditorStore(selectHasActiveBoard)
  const docs = useEditorStore(selectActiveBoardDocs)

  if (!hasActiveBoard) return null

  return (
    <div className={styles.layer} data-testid="board-docs-layer">
      {docs.map((doc) => (
        <DocBlockView key={doc.id} doc={doc} />
      ))}
    </div>
  )
}
