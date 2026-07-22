/**
 * BoardFramesLayer — studio-mode multi-frame board. Renders the ACTIVE
 * board's CURATED set of pages (`board.frames`) as freely-positioned,
 * fully-editable frames, instead of the single-page breakpoint frames
 * CanvasTransformLayer renders for CMS / Visual Component editing.
 *
 * Frame membership: `board.frames` is the source of truth for WHICH pages
 * appear on this board — different boards can curate different subsets of
 * `site.pages` (different flows/screens). Each `BoardFrame` is resolved
 * against `site.pages` by `pageId`; a frame whose page has since been
 * deleted is silently skipped. Membership is managed by `boardSlice`'s
 * `addFrame` / `seedFramesForActiveBoard` / `removeFrame` — this component
 * only reads `board.frames`, it never invents a page that isn't on the list
 * (see `AddFramePicker` for adding one, and the per-frame "×" for removing
 * one).
 *
 * Position: every `BoardFrame` on the list carries a saved `x`/`y` (assigned
 * at add-time by `defaultFramePosition`, `@site/canvas/BoardFramesLayer/frameGrid`)
 * and persists a new one the moment it's dragged, via `setFramePosition`
 * (boardSlice).
 *
 * Empty state: a board with zero frames (e.g. a freshly-created board) shows
 * a centered card instead of a blank canvas, with its own `AddFramePicker` so
 * the first frame is one click away.
 *
 * Per-frame content: each frame wraps its `BreakpointFrame` in a
 * `CanvasPageContext.Provider value={page.id}>`, so `NodeRenderer` resolves
 * that frame's content against ITS OWN page (`selectCanvasPageFor`) instead
 * of falling back to the single active document.
 *
 * Activation + edit routing: a page becomes the one editing machinery acts
 * on (`mutateActiveTree` → `resolveActiveTreeTarget`) via `activePageId`.
 * Rather than threading a page id through the selection/mutation stack, each
 * frame wrapper calls `openPageInCanvas(page.id)` from `onPointerDownCapture`
 * — the CAPTURE phase fires before the node's own click handler, so
 * `activePageId` has already switched by the time a click inside the frame
 * reaches node-selection logic.
 *
 * Drag-to-reposition: the frame's header bar is the drag handle, mirroring
 * `StickyNoteView`'s pointer-capture + screenDelta/zoom pattern so it tracks
 * the cursor 1:1 at any zoom level. Both this layer and the header live
 * inside `CanvasTransformLayer`, so frame coordinates are plain board units
 * — the pan/zoom transform is inherited for free.
 *
 * KNOWN LIMITATION: every studio frame shares one synthetic breakpoint id
 * (`STUDIO_BREAKPOINT.id === 'studio'`), so breakpoint-KEYED chrome inside
 * `BreakpointFrame` (collapsed-state, "open in live", the toolbar's
 * activeBreakpointId-driven highlight) is not per-frame-correct — it behaves
 * as one shared breakpoint across all frames. This is acceptable for this
 * increment because the piece that matters for editing — the selection RING
 * — still resolves correctly per-frame: `BreakpointSelectionOverlay` queries
 * each frame's own iframe document by node id, not by breakpoint id. Revisit
 * if per-frame breakpoint chrome becomes necessary.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio board
 * mode, so `CanvasTransformLayer` can always mount it without an extra check.
 */
import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import type { Breakpoint, Page } from '@core/page-tree'
import type { BoardFrame } from '@core/studio-board'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CanvasPageContext } from '../CanvasContexts'
import { BreakpointFrame } from '../BreakpointFrame'
import { AddFramePicker } from './AddFramePicker'
import styles from './BoardFramesLayer.module.css'

/** Shared synthetic breakpoint every studio frame renders at — see the
 * "KNOWN LIMITATION" note above for what per-frame chrome this costs. */
const STUDIO_BREAKPOINT: Breakpoint = {
  id: 'studio',
  label: 'Studio',
  width: 1024,
  mediaQuery: '(max-width: 1024px)',
  icon: 'monitor',
}

export function BoardFramesLayer() {
  const board = useEditorStore(selectActiveBoard)
  const pages = useEditorStore((s) => s.site?.pages ?? [])
  const activePageId = useEditorStore((s) => s.activePageId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setFramePosition = useEditorStore((s) => s.setFramePosition)
  const removeFrame = useEditorStore((s) => s.removeFrame)

  if (!board) return null

  // board.frames is membership — resolve each against site.pages and drop
  // any frame whose page no longer exists (deleted since it was added).
  const framesWithPages = board.frames
    .map((frame) => ({ frame, page: pages.find((p) => p.id === frame.pageId) }))
    .filter(
      (entry): entry is { frame: BoardFrame; page: Page } => entry.page !== undefined,
    )

  return (
    <div className={styles.layer} data-testid="board-frames-layer">
      {framesWithPages.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyStateTitle}>No screens on this board yet</p>
          <p className={styles.emptyStateBody}>Add a page to start laying out this flow.</p>
          <AddFramePicker />
        </div>
      ) : (
        framesWithPages.map(({ frame, page }) => (
          <BoardFrameView
            key={page.id}
            page={page}
            x={frame.x}
            y={frame.y}
            isActive={page.id === activePageId}
            onActivate={() => openPageInCanvas(page.id)}
            onMove={(nx, ny) => setFramePosition(page.id, nx, ny)}
            onRemove={() => removeFrame(page.id)}
          />
        ))
      )}
    </div>
  )
}

interface DragState {
  pointerId: number
  startClientX: number
  startClientY: number
  frameX: number
  frameY: number
}

interface BoardFrameViewProps {
  page: Page
  x: number
  y: number
  isActive: boolean
  onActivate: () => void
  onMove: (x: number, y: number) => void
  onRemove: () => void
}

function BoardFrameView({ page, x, y, isActive, onActivate, onMove, onRemove }: BoardFrameViewProps) {
  const dragRef = useRef<DragState | null>(null)

  // Capture phase — fires before the frame's own node-click handling, so
  // `activePageId` is already switched to this page by the time selection
  // logic runs (see the module doc's "Activation + edit routing" note).
  const handleActivateCapture = () => {
    if (!isActive) onActivate()
  }

  const handleHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      frameX: x,
      frameY: y,
    }
  }

  const handleHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom
    onMove(drag.frameX + dx, drag.frameY + dy)
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  return (
    <div
      className={styles.frame}
      data-page-id={page.id}
      data-active={isActive ? 'true' : undefined}
      style={{ '--frame-x': `${x}px`, '--frame-y': `${y}px` } as CSSProperties}
      onPointerDownCapture={handleActivateCapture}
    >
      <div
        className={styles.header}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className={styles.title}>{page.title}</span>
        {isActive && <span className={styles.activeBadge}>Active</span>}
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          className={styles.removeButton}
          aria-label={`Remove ${page.title} from this board`}
          tooltip="Remove from board"
          // Removing membership is a pointerdown target inside the drag
          // handle — stop the event reaching the header's own drag/activate
          // handlers so a click on "×" never starts a frame drag.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRemove}
        >
          <CloseIcon size={11} aria-hidden="true" />
        </Button>
      </div>
      <CanvasPageContext.Provider value={page.id}>
        <BreakpointFrame
          page={page}
          breakpoint={STUDIO_BREAKPOINT}
          isActive={isActive}
          onActivate={onActivate}
        />
      </CanvasPageContext.Provider>
    </div>
  )
}
