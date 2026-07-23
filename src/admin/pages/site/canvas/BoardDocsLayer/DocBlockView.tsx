/**
 * DocBlockView — one draggable, markdown-rendered documentation card.
 *
 * Drag: pointerdown on the header bar (the drag handle) starts a drag;
 * pointer capture keeps the move/up handlers firing even if the cursor
 * leaves the card. Screen-space deltas are divided by the canvas `zoom` so
 * the card tracks the cursor 1:1 regardless of zoom level. The body — where
 * the rendered markdown / edit textarea lives — carries NO pointer handlers,
 * so mouse-dragging inside it just selects text instead of moving the card
 * (mirrors `StickyNoteView`'s text-exclusion, but as a dedicated handle
 * rather than an excluded region, since doc-block bodies are larger and
 * read-heavy).
 *
 * Edit: double-click anywhere on the card (outside the delete button) enters
 * an editing state that swaps the rendered markdown for a raw-markdown
 * `<textarea>`; blur commits via `updateDocMarkdown` and leaves editing.
 * This is a local editing session only — it does NOT reuse `inlineEditSlice`,
 * which is page-tree specific.
 *
 * Render: `doc.markdown` goes through `renderMarkdownToHtml` (the same
 * publisher-grade markdown renderer used elsewhere) and then `sanitizeRichtext`
 * (the DOMPurify wrapper in `@core/sanitize`) before `dangerouslySetInnerHTML`
 * — markdown is user-authored content, so it is never trusted unsanitized.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { DocBlock } from '@core/studio-board'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'
import { sanitizeRichtext } from '@core/sanitize'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import { computeSnap, collectPeerRects, SNAP_THRESHOLD_BOARD_UNITS } from '../boardSnapping'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './DocBlockView.module.css'

interface DocBlockViewProps {
  doc: DocBlock
}

interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  docX: number
  docY: number
}

export function DocBlockView({ doc }: DocBlockViewProps) {
  const moveDoc = useEditorStore((s) => s.moveDoc)
  const updateDocMarkdown = useEditorStore((s) => s.updateDocMarkdown)
  const removeDoc = useEditorStore((s) => s.removeDoc)

  const dragRef = useRef<DragState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(doc.markdown)

  // Focus the textarea the moment it becomes editable.
  useEffect(() => {
    if (isEditing) textareaRef.current?.focus()
  }, [isEditing])

  const handleHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-doc-chrome]')) return

    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      docX: doc.x,
      docY: doc.y,
    }
  }

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return

    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom
    const rawX = drag.docX + dx
    const rawY = drag.docY + dy

    // Snap to the OTHER furniture on the board (Phase 6B) — every other
    // frame, note, and doc, excluding this doc block itself.
    const board = selectActiveBoard(useEditorStore.getState())
    const peers = board ? collectPeerRects(board, { kind: 'doc', id: doc.id }) : []
    const snapped = computeSnap(
      { x: rawX, y: rawY, width: doc.w, height: doc.h },
      peers,
      SNAP_THRESHOLD_BOARD_UNITS,
    )
    useEditorStore.getState().setBoardSnapGuides(snapped.guides)
    moveDoc(doc.id, snapped.x, snapped.y)
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null
      useEditorStore.getState().setBoardSnapGuides([])
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-doc-chrome]')) return
    if (isEditing) return
    setDraft(doc.markdown)
    setIsEditing(true)
  }

  const handleTextareaBlur = () => {
    updateDocMarkdown(doc.id, draft)
    setIsEditing(false)
  }

  const renderedHtml = sanitizeRichtext(renderMarkdownToHtml(doc.markdown))

  return (
    <div
      className={styles.doc}
      // Board-coordinate placement — the doc block lives inside
      // CanvasTransformLayer, which already carries the pan/zoom transform,
      // so these are plain board units with no manual pan/zoom math. Set as
      // CSS custom properties (not raw left/top/width/height) so the module
      // reads them back via var(--x) per the project's inline-style convention.
      style={{
        '--doc-x': `${doc.x}px`,
        '--doc-y': `${doc.y}px`,
        '--doc-w': `${doc.w}px`,
        '--doc-h': `${doc.h}px`,
      } as CSSProperties}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className={styles.header}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className={styles.title}>Doc</span>
        <div className={styles.chrome} data-doc-chrome>
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            tone="danger"
            aria-label="Delete doc block"
            // Stop the pointerdown reaching the header's drag handler so a
            // click on delete never starts a drag.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => removeDoc(doc.id)}
          >
            <CloseIcon size={11} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className={styles.body}>
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={handleTextareaBlur}
          />
        ) : doc.markdown.trim() ? (
          <div className={styles.rendered} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        ) : (
          <div className={styles.placeholder}>Double-click to write docs</div>
        )}
      </div>
    </div>
  )
}
