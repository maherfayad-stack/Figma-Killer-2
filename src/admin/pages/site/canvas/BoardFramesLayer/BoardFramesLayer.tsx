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
 * (see `AddFramePicker` for adding one, and each frame header's right-click
 * "Remove from board" for removing one).
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
 * — the pan/zoom transform is inherited for free. The header's pointerdown
 * handler only arms drag state for the primary button (`e.button === 0`), so
 * a right-click falls through untouched to `onContextMenu` — it opens the
 * header's context menu (Rename / Remove from board) without ever starting
 * a drag or losing the frame's activation.
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
 * Virtualization: a live `BreakpointFrame` (iframe + full `NodeRenderer`
 * tree) is only mounted for frames whose board-space rect intersects the
 * current viewport, inflated by `FRAME_VIEWPORT_MARGIN` (see
 * `frameVirtualization.ts`) so scrolling/panning doesn't pop iframes in and
 * out right at the edge. Offscreen frames render a static placeholder body
 * instead — no iframe, no animation. Only the BODY is swapped: the outer
 * `.frame` div, its position (`--frame-x/--frame-y`), the drag header, and
 * its title/rename/context-menu all stay mounted and functional on
 * placeholders too, so position, activation, drag, rename, and removal work
 * regardless of on-screen state. `key={page.id}` on the list ensures React
 * cleanly (re)mounts a fresh iframe when a frame re-enters the viewport.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio board
 * mode, so `CanvasTransformLayer` can always mount it without an extra check.
 */
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import type { Breakpoint, Page } from '@core/page-tree'
import type { BoardFrame } from '@core/studio-board'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { useInlineRename } from '@site/hooks/useInlineRename'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { CanvasPageContext, CanvasViewportActionsContext } from '../CanvasContexts'
import { BreakpointFrame } from '../BreakpointFrame'
import { AddFramePicker } from './AddFramePicker'
import { FRAME_WIDTH, FRAME_HEIGHT } from './frameGrid'
import { FRAME_VIEWPORT_MARGIN, isFrameOnScreen } from './frameVirtualization'
import { resizeFrameRect, MIN_FRAME_SIZE, type FrameResizeRect, type ResizeHandle } from './frameResize'
import { computeSnap, collectPeerRects, SNAP_THRESHOLD_BOARD_UNITS } from '../boardSnapping'
import styles from './BoardFramesLayer.module.css'

/** Header height (board units) added to the frame's own height for the
 * on-screen intersection test, so the drag header itself isn't cut off the
 * rect. */
const FRAME_HEADER_HEIGHT = 48

/**
 * Shared chrome every studio frame's synthetic breakpoint carries — see the
 * "KNOWN LIMITATION" note above for what per-frame chrome this costs. Only
 * `width` varies per frame (Phase 6E — resizable frames); each frame builds
 * its own `Breakpoint` via `buildStudioBreakpoint` below instead of sharing
 * one hardcoded 1024px width.
 */
const STUDIO_BREAKPOINT_BASE = {
  id: 'studio',
  label: 'Studio',
  mediaQuery: '(max-width: 1024px)',
  icon: 'monitor',
} as const

/** This frame's synthetic breakpoint, sized to ITS OWN board width. */
function buildStudioBreakpoint(width: number): Breakpoint {
  return { ...STUDIO_BREAKPOINT_BASE, width }
}

/**
 * Every resize handle a frame renders. Cursor-per-handle is a CSS concern
 * (`[data-handle="..."]` selectors in `BoardFramesLayer.module.css`), not a
 * JS-driven inline style.
 */
const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function BoardFramesLayer() {
  const board = useEditorStore(selectActiveBoard)
  const pages = useEditorStore((s) => s.site?.pages ?? [])
  const activePageId = useEditorStore((s) => s.activePageId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setFramePosition = useEditorStore((s) => s.setFramePosition)
  const setFrameSize = useEditorStore((s) => s.setFrameSize)
  const removeFrame = useEditorStore((s) => s.removeFrame)
  const renamePage = useEditorStore((s) => s.renamePage)
  const zoom = useEditorStore((s) => s.zoom)
  const panX = useEditorStore((s) => s.panX)
  const panY = useEditorStore((s) => s.panY)

  // The untransformed canvas root's client size — this layer's ancestor
  // applies `translate(panX, panY) scale(zoom)`, so the root's own box is
  // the screen-space viewport that frame rects are tested against (see
  // `frameVirtualization.ts`'s module doc for the coordinate math).
  const viewportActions = useContext(CanvasViewportActionsContext)
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    const root = viewportActions?.canvasRootRef.current
    if (!root) return
    const syncSize = () => setViewportSize({ width: root.clientWidth, height: root.clientHeight })
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [viewportActions])

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
        framesWithPages.map(({ frame, page }) => {
          // Per-frame size (Phase 6E) — a frame without a saved width/height
          // falls back to the shared 1024x800 default, so pre-6E boards.json
          // files render unchanged.
          const width = frame.width ?? FRAME_WIDTH
          const height = frame.height ?? FRAME_HEIGHT
          const isOnScreen = isFrameOnScreen(
            { x: frame.x, y: frame.y, width, height: height + FRAME_HEADER_HEIGHT },
            { panX, panY, zoom, width: viewportSize.width, height: viewportSize.height },
            FRAME_VIEWPORT_MARGIN,
          )
          return (
            <BoardFrameView
              key={page.id}
              page={page}
              x={frame.x}
              y={frame.y}
              width={width}
              height={height}
              isActive={page.id === activePageId}
              isOnScreen={isOnScreen}
              onActivate={() => openPageInCanvas(page.id)}
              onMove={(nx, ny) => setFramePosition(page.id, nx, ny)}
              onResize={(nw, nh) => setFrameSize(page.id, nw, nh)}
              onRemove={() => removeFrame(page.id)}
              onRename={(title) => renamePage(page.id, title)}
            />
          )
        })
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

interface ResizeDragState {
  pointerId: number
  handle: ResizeHandle
  startClientX: number
  startClientY: number
  /** The frame's full rect at drag-start — the pure `resizeFrameRect` anchor. */
  anchor: FrameResizeRect
}

interface BoardFrameViewProps {
  page: Page
  x: number
  y: number
  /** This frame's own board-space size — Phase 6E (falls back to
   * `FRAME_WIDTH`/`FRAME_HEIGHT` upstream in `BoardFramesLayer`, so this
   * component always receives a concrete size). */
  width: number
  height: number
  isActive: boolean
  isOnScreen: boolean
  onActivate: () => void
  onMove: (x: number, y: number) => void
  onResize: (width: number, height: number) => void
  onRemove: () => void
  onRename: (title: string) => void
}

function BoardFrameView({
  page,
  x,
  y,
  width,
  height,
  isActive,
  isOnScreen,
  onActivate,
  onMove,
  onResize,
  onRemove,
  onRename,
}: BoardFrameViewProps) {
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeDragState | null>(null)
  const rename = useInlineRename({ onCommit: onRename })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  // Capture phase — fires before the frame's own node-click handling, so
  // `activePageId` is already switched to this page by the time selection
  // logic runs (see the module doc's "Activation + edit routing" note).
  const handleActivateCapture = () => {
    if (!isActive) onActivate()
  }

  const handleHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only the primary (left) button starts a move-drag — a right-click's
    // pointerdown must fall through to `onContextMenu` untouched, never
    // arming drag state (see the module doc's "Drag-to-reposition" note).
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      frameX: x,
      frameY: y,
    }
  }

  const handleHeaderContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom
    const rawX = drag.frameX + dx
    const rawY = drag.frameY + dy

    // Snap to the OTHER furniture on the board (Phase 6B) — every other
    // frame, note, and doc, excluding this frame's own page.
    const board = selectActiveBoard(useEditorStore.getState())
    const peers = board ? collectPeerRects(board, { kind: 'frame', pageId: page.id }) : []
    const snapped = computeSnap({ x: rawX, y: rawY, width, height }, peers, SNAP_THRESHOLD_BOARD_UNITS)
    useEditorStore.getState().setBoardSnapGuides(snapped.guides)
    onMove(snapped.x, snapped.y)
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null
      useEditorStore.getState().setBoardSnapGuides([])
    }
  }

  // Resize handles — same pointer-capture + screenDelta/zoom pattern as the
  // header drag above, so a handle tracks the cursor 1:1 at any zoom. The
  // geometry itself (which edges move, the min-size clamp) is the pure
  // `resizeFrameRect` — this handler only converts screen pixels to board
  // units and applies the result via the existing `onMove` (position) /
  // `onResize` (size) callbacks.
  const handleResizePointerDown = (handle: ResizeHandle) => (e: ReactPointerEvent<HTMLDivElement>) => {
    // A handle sits inside the frame's own pointerdown-capture region — stop
    // it reaching `handleActivateCapture`/the header's drag handlers so
    // grabbing a handle never also starts a move-drag.
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeRef.current = {
      pointerId: e.pointerId,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      anchor: { x, y, width, height },
    }
  }

  const handleResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom
    const next = resizeFrameRect(drag.anchor, drag.handle, dx, dy, MIN_FRAME_SIZE)
    if (next.x !== drag.anchor.x || next.y !== drag.anchor.y) onMove(next.x, next.y)
    onResize(next.width, next.height)
  }

  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) resizeRef.current = null
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
        onContextMenu={handleHeaderContextMenu}
        onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); rename.start(page.title) }}
      >
        {/* Name only — no Active badge (active styling is the CSS-driven
            selection ring on `[data-active='true'] .header`, set above) and
            no inline "×" (moved to the right-click context menu below). */}
        {rename.isRenaming ? (
          <Input
            ref={rename.inputRef}
            fieldSize="xs"
            autoFocus
            value={rename.value}
            onChange={(e) => rename.setValue(e.target.value)}
            onKeyDown={rename.handleKeyDown}
            onBlur={rename.commit}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Rename ${page.title}`}
            className={styles.titleInput}
          />
        ) : (
          <span className={styles.title}>{page.title}</span>
        )}
      </div>

      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={`${page.title} frame options`}
          animateExit
          onClose={() => setContextMenu(null)}
        >
          <ContextMenuItem
            onClick={() => { setContextMenu(null); rename.start(page.title) }}
          >
            <span aria-hidden="true"><PenSquareSolidIcon size={13} /></span>
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            danger
            onClick={() => { setContextMenu(null); onRemove() }}
          >
            <span aria-hidden="true"><CloseIcon size={13} /></span>
            Remove from board
          </ContextMenuItem>
        </ContextMenu>,
        document.body,
      )}
      {/* Sized to the frame's OWN width/height (Phase 6E) — a real "device
          box" for both the live iframe and the offscreen placeholder, so
          resize handles have a consistent box to anchor to regardless of
          on-screen state. Content taller than `height` scrolls inside. */}
      <div
        className={styles.frameBody}
        style={{ '--frame-w': `${width}px`, '--frame-h': `${height}px` } as CSSProperties}
      >
        {isOnScreen ? (
          <CanvasPageContext.Provider value={page.id}>
            <BreakpointFrame
              page={page}
              breakpoint={buildStudioBreakpoint(width)}
              isActive={isActive}
              onActivate={onActivate}
            />
          </CanvasPageContext.Provider>
        ) : (
          <div className={styles.offscreenPlaceholder} data-testid="board-frame-placeholder">
            <span className={styles.offscreenPlaceholderTitle}>{page.title}</span>
          </div>
        )}
      </div>
      {/* Resize handles — active frame only, mirroring the selection ring's
          own active-only visibility. Corners resize both axes; edges resize
          one. See frameResize.ts for the geometry. */}
      {isActive && (
        <div className={styles.resizeHandles} aria-hidden="true">
          {RESIZE_HANDLES.map((handle) => (
            <div
              key={handle}
              className={styles.resizeHandle}
              data-handle={handle}
              data-testid={`board-frame-resize-${handle}`}
              onPointerDown={handleResizePointerDown(handle)}
              onPointerMove={handleResizePointerMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          ))}
        </div>
      )}
    </div>
  )
}
