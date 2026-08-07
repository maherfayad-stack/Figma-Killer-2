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
 * `addFrame` / `seedFramesForActiveBoard` / `removeFrameById` — this component
 * only reads `board.frames`, it never invents a page that isn't on the list
 * (see `AddFramePicker` for adding one, and each frame header's right-click
 * "Remove from board" for removing one).
 *
 * Position: every `BoardFrame` on the list carries a saved `x`/`y` (assigned
 * at add-time by `defaultFramePosition`, `@core/studio-board`)
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
 * of falling back to the single active document. WS-10 Phase 2 adds a
 * SECOND, separate provider alongside it — `CanvasFrameContext.Provider
 * value={frame.id}` — so a "duplicate as variant" sibling frame of the same
 * page (same node ids, trap #2) can be told apart for selection/hover
 * scoping. See that context's own doc for why this can't just reuse the
 * page id or the synthetic breakpoint id.
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
 * regardless of on-screen state. `key={frame.id}` on the list (WS-10 Phase 2
 * — was `page.id`, which two "duplicate as variant" frames of one page would
 * collide on) ensures React cleanly (re)mounts a fresh iframe when a frame
 * re-enters the viewport, and gives each variant its own component identity.
 *
 * Self-gates on `selectActiveBoard`: renders nothing outside studio board
 * mode, so `CanvasTransformLayer` can always mount it without an extra check.
 *
 * Frame multi-selection (WS-7.1): distinct from node selection
 * (`selectedFrameIds`, boardSlice — see that slice's module doc). Three entry
 * points, all funnelled into the same `selectFrame`/`setSelectedFrameIds`
 * actions:
 *   - Header click (`BoardFrameView`) — replace on a plain click, toggle-add
 *     on Shift-click, mirroring the node-selection click contract in
 *     `CanvasRoot.onNodeClick`.
 *   - ⌘/Ctrl+A — a document-level listener in `CanvasRoot.tsx`, scoped by
 *     intent (not typing in an editable field) rather than DOM focus.
 *   - Marquee drag on empty canvas — `useMarqueeSelection.ts` (own module,
 *     extracted for `module-size-budgets` — see its own doc comment for the
 *     "Marquee gesture arbitration" reasoning: why the listeners live on
 *     `canvasRootRef.current` rather than JSX pointer props on `.layer`, and
 *     how that also resolves who wins against `useCanvas`'s pan gesture).
 */
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore, lookupCanvasPageById } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import type { Page } from '@core/page-tree'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { AddFramePicker } from './AddFramePicker'
import { NewPageButton } from './NewPageButton'
import { FRAME_WIDTH, FRAME_HEIGHT, FRAME_HEADER_HEIGHT } from '@core/studio-board'
import { FRAME_VIEWPORT_MARGIN, isFrameOnScreen } from './frameVirtualization'
import { resolveFramesWithPages } from './resolveFramesWithPages'
import { useMarqueeSelection } from './useMarqueeSelection'
import { BoardFrameView } from './BoardFrameView'
import styles from './BoardFramesLayer.module.css'

// Stable fallback reference — `?? []` inline would hand back a NEW array every
// render, which a Zustand selector must never do (breaks useSyncExternalStore's
// "did this change" check and can spiral into a "Maximum update depth
// exceeded" render loop once anything downstream reacts to the selected value).
const EMPTY_PAGES: (Page | null)[] = []

export function BoardFramesLayer() {
  const board = useEditorStore(selectActiveBoard)
  // C2 — ONLY this board's own pages, never whole `site.pages` (a fresh
  // array on ANY page edit — Mutative copy-on-write). `useShallow` keeps
  // identity stable across an edit to a page not on this board.
  // `lookupCanvasPageById` is C1's shared sweep-scoped Map cache (store.ts).
  const relevantPages = useEditorStore(
    useShallow((s) => {
      const activeBoard = selectActiveBoard(s)
      const site = s.site
      if (!activeBoard || !site) return EMPTY_PAGES
      return activeBoard.frames.map((frame) => lookupCanvasPageById(site, frame.pageId))
    }),
  )
  const activePageId = useEditorStore((s) => s.activePageId)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const setFramePosition = useEditorStore((s) => s.setFramePosition)
  const setFrameSize = useEditorStore((s) => s.setFrameSize)
  const removeFrameById = useEditorStore((s) => s.removeFrameById)
  const duplicateFrameAsVariant = useEditorStore((s) => s.duplicateFrameAsVariant)
  const renamePage = useEditorStore((s) => s.renamePage)
  const zoom = useEditorStore((s) => s.zoom)
  const panX = useEditorStore((s) => s.panX)
  const panY = useEditorStore((s) => s.panY)
  // WS-7.1 — frame multi-selection, a separate domain from node selection.
  // Subscribed for the render (selection ring / bounding box); the marquee
  // effect below reads/writes this fresh via `useEditorStore.getState()`
  // instead, since it intentionally does not re-run on every store update.
  const selectedFrameIds = useEditorStore((s) => s.selectedFrameIds)

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

  // Marquee drag (WS-7.1) — screen-space rect, portaled outside the
  // transformed layer below. Gesture wiring + arbitration lives in
  // `useMarqueeSelection.ts` (own module, see its doc comment). `layerRef` is
  // both its frame-rect source (it hit-tests each frame's RENDERED box) and
  // its "are we on a studio board?" gate — `.layer` renders in board mode only.
  const layerRef = useRef<HTMLDivElement>(null)
  const marqueeRect = useMarqueeSelection(viewportActions?.canvasRootRef, layerRef)

  if (!board) return null

  const framesWithPages = resolveFramesWithPages(board.frames, relevantPages)

  // One bounding box around the whole multi-selection (board-space, so it
  // lives inside `.layer` and pans/zooms with the frames it encloses).
  const selectedRects = framesWithPages.filter(({ page }) => selectedFrameIds.includes(page.id))
  const selectionBoundingBox =
    selectedRects.length > 1
      ? (() => {
          const boxes = selectedRects.map(({ frame }) => ({
            left: frame.x,
            top: frame.y,
            right: frame.x + (frame.width ?? FRAME_WIDTH),
            bottom: frame.y + (frame.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT,
          }))
          return {
            x: Math.min(...boxes.map((b) => b.left)),
            y: Math.min(...boxes.map((b) => b.top)),
            right: Math.max(...boxes.map((b) => b.right)),
            bottom: Math.max(...boxes.map((b) => b.bottom)),
          }
        })()
      : null

  const canvasRootEl = viewportActions?.canvasRootRef.current ?? null

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      data-testid="board-frames-layer"
    >
      {framesWithPages.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyStateTitle}>No screens on this board yet</p>
          <p className={styles.emptyStateBody}>Create a new page, or add an existing one to start laying out this flow.</p>
          <div className={styles.emptyStateActions}>
            <NewPageButton />
            <AddFramePicker />
          </div>
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
              key={frame.id}
              frame={frame}
              page={page}
              x={frame.x}
              y={frame.y}
              width={width}
              height={height}
              hasManualHeight={frame.height !== undefined}
              isActive={page.id === activePageId}
              isSelected={selectedFrameIds.includes(page.id)}
              isOnScreen={isOnScreen}
              onActivate={() => openPageInCanvas(page.id)}
              onMove={(nx, ny) => setFramePosition(frame.id, nx, ny)}
              onResize={(nw, nh) => setFrameSize(frame.id, nw, nh)}
              onRemove={() => removeFrameById(frame.id)}
              onRename={(title) => renamePage(page.id, title)}
              onDuplicateAsVariant={(axes) => duplicateFrameAsVariant(frame.id, axes)}
            />
          )
        })
      )}

      {selectionBoundingBox && (
        <div
          className={styles.selectionBoundingBox}
          style={{
            '--box-x': `${selectionBoundingBox.x}px`,
            '--box-y': `${selectionBoundingBox.y}px`,
            '--box-w': `${selectionBoundingBox.right - selectionBoundingBox.x}px`,
            '--box-h': `${selectionBoundingBox.bottom - selectionBoundingBox.y}px`,
          } as CSSProperties}
        />
      )}

      {marqueeRect && canvasRootEl && createPortal(
        <div
          className={styles.marquee}
          style={{
            '--marquee-x': `${marqueeRect.x}px`,
            '--marquee-y': `${marqueeRect.y}px`,
            '--marquee-w': `${marqueeRect.width}px`,
            '--marquee-h': `${marqueeRect.height}px`,
          } as CSSProperties}
        />,
        canvasRootEl,
      )}
    </div>
  )
}
