/**
 * BoardFramesLayer — studio-mode multi-frame board (Phase 1, Increment 1B
 * Piece 2). Renders every page in `site.pages` as its own freely-positioned,
 * fully-editable frame on the board, instead of the single-page breakpoint
 * frames CanvasTransformLayer renders for CMS / Visual Component editing.
 *
 * Position: read from the active board's `BoardFrame` (`board.frames`,
 * keyed by `pageId`) when one has been saved, otherwise a default 2-column
 * grid slot derived from the page's index in `site.pages`. `site.pages` is
 * the source of truth for WHICH frames exist — `board.frames` only stores
 * positions — so a page with no saved frame still renders (at its grid
 * default) and persists a real position the moment it's dragged, via
 * `setFramePosition` (boardSlice).
 *
 * Per-frame content: each frame wraps its `BreakpointFrame` in a
 * `CanvasPageContext.Provider value={page.id}>`, so `NodeRenderer` resolves
 * that frame's content against ITS OWN page (`selectCanvasPageFor`) instead
 * of falling back to the single active document — the keystone piece 1
 * landed this without touching NodeRenderer/CanvasContexts again here.
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
import { CanvasPageContext } from '../CanvasContexts'
import { BreakpointFrame } from '../BreakpointFrame'
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

const FRAME_WIDTH = 1024
const FRAME_HEIGHT = 800
const FRAME_GAP = 80
const GRID_COLUMNS = 2

/** Default grid slot for a page with no saved `BoardFrame` position yet. */
function defaultFramePosition(index: number): { x: number; y: number } {
  const col = index % GRID_COLUMNS
  const row = Math.floor(index / GRID_COLUMNS)
  return { x: col * (FRAME_WIDTH + FRAME_GAP), y: row * (FRAME_HEIGHT + FRAME_GAP) }
}

export function BoardFramesLayer() {
  const board = useEditorStore(selectActiveBoard)
  const pages = useEditorStore((s) => s.site?.pages ?? [])
  const activePageId = useEditorStore((s) => s.activePageId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setFramePosition = useEditorStore((s) => s.setFramePosition)

  if (!board) return null

  return (
    <div className={styles.layer} data-testid="board-frames-layer">
      {pages.map((page, index) => {
        const saved = board.frames.find((f) => f.pageId === page.id)
        const { x, y } = saved ?? defaultFramePosition(index)
        return (
          <BoardFrameView
            key={page.id}
            page={page}
            x={x}
            y={y}
            isActive={page.id === activePageId}
            onActivate={() => openPageInCanvas(page.id)}
            onMove={(nx, ny) => setFramePosition(page.id, nx, ny)}
          />
        )
      })}
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
}

function BoardFrameView({ page, x, y, isActive, onActivate, onMove }: BoardFrameViewProps) {
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
