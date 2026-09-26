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
 * (see `AddPagePicker` for adding one, and each frame header's right-click
 * "Remove from board" for removing one).
 *
 * Position: every `BoardFrame` on the list carries a saved `x`/`y` (assigned
 * at add-time by `defaultFramePosition`, `@core/studio-board`)
 * and persists a new one the moment it's dragged, via `setFramePosition`
 * (boardSlice).
 *
 * Empty state: a board with zero frames (e.g. a freshly-created board) shows
 * a centered card instead of a blank canvas, with its own `AddPagePicker` so
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
 * Every studio frame shares one synthetic breakpoint id
 * (`STUDIO_BREAKPOINT.id === 'studio'`), so breakpoint-KEYED chrome inside
 * `BreakpointFrame` (collapsed-state, "open in live", the toolbar's
 * activeBreakpointId-driven highlight) is not per-frame-correct — it behaves
 * as one shared breakpoint across all frames. Board frames therefore render
 * WITHOUT that chrome row (`showBreakpointChrome={false}` — see the prop's
 * doc on `BreakpointFrame`): a board frame's identity, size and actions all
 * live on its OWN header and in the Properties panel, so the breakpoint row
 * was a second, board-global strip promising per-frame control it could not
 * deliver. The piece that matters for editing — the selection RING — was
 * never breakpoint-keyed and still resolves per-frame:
 * `BreakpointSelectionOverlay` queries each frame's own iframe document by
 * node id.
 *
 * Virtualization + the mount pool: a live `BreakpointFrame` (iframe + full
 * `NodeRenderer` tree) is only mounted for frames whose board-space rect
 * intersects the current viewport, inflated by `FRAME_VIEWPORT_MARGIN` (see
 * `frameVirtualization.ts`) so scrolling/panning doesn't pop iframes in and
 * out right at the edge, PLUS the recently-departed frames the pool still
 * holds (`framePool.ts`) — leaving the viewport no longer throws a document
 * away, so panning back to where you just were costs nothing at all.
 * Eviction is least-recently-on-screen, and the budget is the ONE thing that
 * varies: `framePoolBudget('live', n)` once a Tier-2 board's dev server is
 * READY and its frames are cross-origin documents against a real dev-server
 * process, `framePoolBudget('portal', n)` for every other frame — a Tier 0/1
 * board's `srcDoc` frames, and a Tier-2 board's frames while its dev server is
 * booting, failed or stopped, when each one is its same-origin fallback. There is one pool, one retention list and one budget per render —
 * see `framePool.ts` for why there used to be two, and what each budget is
 * measured against.
 *
 * Frames outside the pool render a static placeholder body instead — no
 * iframe, no animation. Only the BODY is swapped: the outer `.frame` div,
 * its position (`--frame-x/--frame-y`), the drag header, and its
 * title/rename/context-menu all stay mounted and functional on placeholders
 * too, so position, activation, drag, rename, and removal work regardless of
 * on-screen state. `key={frame.id}` on the list (WS-10 Phase 2 — was
 * `page.id`, which two "duplicate as variant" frames of one page would
 * collide on) ensures React cleanly (re)mounts a fresh iframe when a frame
 * re-enters the viewport, and gives each variant its own component identity.
 *
 * The retention list lives in `useState` (not a ref — `react-hooks/refs`,
 * part of this repo's React Compiler lint set, flags reading `ref.current`
 * during render) and is advanced DURING render through react.dev's
 * "adjusting state when something changes" pattern; the `key` tag on it is
 * what stops that looping. See the call site.
 *
 * Self-gates on `selectHasActiveBoard`: renders nothing outside studio board
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
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore, lookupCanvasPageById } from '@site/store/store'
import { selectActiveBoardFrames, selectHasActiveBoard } from '@site/store/slices/boardSelectors'
import type { Page } from '@core/page-tree'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { AddPagePicker } from './AddPagePicker'
import { FRAME_WIDTH, FRAME_HEIGHT, FRAME_HEADER_HEIGHT } from '@core/studio-board'
import { FRAME_VIEWPORT_MARGIN, isFrameOnScreen } from './frameVirtualization'
import { nextFramePool, sameFramePool, type FrameMountCost } from './framePool'
import { resolveFramesWithPages } from './resolveFramesWithPages'
import { getStudioTrustTier, subscribeStudioTrustTier } from '@site/studio/studioProjectTrust'
import { useDevServerReadiness } from '@site/studio/useDevServerReadiness'
import { useAdminUi } from '@admin/state/adminUi'
import { useMarqueeSelection } from './useMarqueeSelection'
import { BoardFrameView } from './BoardFrameView'
import styles from './BoardFramesLayer.module.css'

// Stable fallback reference — `?? []` inline would hand back a NEW array every
// render, which a Zustand selector must never do (breaks useSyncExternalStore's
// "did this change" check and can spiral into a "Maximum update depth
// exceeded" render loop once anything downstream reacts to the selected value).
const EMPTY_PAGES: (Page | null)[] = []

/** Stable empty retention, for the same "never a fresh literal" reason. */
const EMPTY_RETENTION: string[] = []

/**
 * The pool's membership, tagged with the inputs it was derived from. The tag
 * is what lets the derivation happen during render without looping — see the
 * `useState` below.
 */
interface FrameRetention {
  /** The `poolKey` this membership was computed for — on-screen ids plus the frame cost. */
  key: string
  /** Most-recently-on-screen first. See `framePool.ts`. */
  ids: string[]
}

const INITIAL_RETENTION: FrameRetention = { key: '\u0000', ids: EMPTY_RETENTION }

export function BoardFramesLayer() {
  // C3 (this change) — subscribe to `board.frames` alone, not the whole
  // `Board`. Every board-mutating helper does copy-on-write on the whole
  // `Board` object for Mutative/history correctness, so `selectActiveBoard`
  // changes reference on a note/doc/guide write too — this layer only ever
  // renders frames, so it should only ever re-render on a frames write. See
  // `boardSlice.ts`'s doc on `selectActiveBoardFrames` for why this is safe.
  const hasActiveBoard = useEditorStore(selectHasActiveBoard)
  const frames = useEditorStore(selectActiveBoardFrames)
  // C2 — ONLY this board's own pages, never whole `site.pages` (a fresh
  // array on ANY page edit — Mutative copy-on-write). `useShallow` keeps
  // identity stable across an edit to a page not on this board.
  // `lookupCanvasPageById` is C1's shared sweep-scoped Map cache (store.ts).
  const relevantPages = useEditorStore(
    useShallow((s) => {
      const activeBoardFrames = selectActiveBoardFrames(s)
      const site = s.site
      if (!site) return EMPTY_PAGES
      return activeBoardFrames.map((frame) => lookupCanvasPageById(site, frame.pageId))
    }),
  )
  const activePageId = useEditorStore((s) => s.activePageId)
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

  // The pool's membership (most-recently-on-screen first). See
  // `framePool.ts`; the derivation itself is below, next to the on-screen set
  // it needs.
  const [retention, setRetention] = useState<FrameRetention>(INITIAL_RETENTION)
  // What one mounted frame costs on this board, and therefore how big the
  // pool may be. A Tier-2 frame whose dev server is READY is a cross-origin
  // document against a real dev-server process, so it gets the capped
  // `'live'` budget. Until then — booting, failed, or never started — a
  // Tier-2 frame is its same-origin fallback, exactly what a Tier 0/1 frame
  // is, and gets the portal budget with its headroom. That headroom is what
  // keeps a departed frame mounted long enough to be rasterized into its
  // poster (`useFramePosterCapture`); under the live budget a frame leaving
  // a full screen was evicted on the spot, so a Tier-2 board whose server was
  // not up never got a poster at all (P6-C). This is the ONLY place the trust
  // tier touches mounting.
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const devServer = useDevServerReadiness(projectDir)
  const frameCost: FrameMountCost = trust === 'run-project' && devServer.phase === 'ready' ? 'live' : 'portal'

  // Resolved frames + the viewport intersection test, hoisted ABOVE this
  // component's `hasActiveBoard` early return because the retention effect
  // below is a hook and hooks cannot live after one. Both are cheap array
  // passes over this board's own frames — never a whole-site scan.
  const framesWithPages = resolveFramesWithPages(frames, relevantPages)
  const onScreenFrameIds = framesWithPages
    .filter(({ frame }) =>
      isFrameOnScreen(
        {
          x: frame.x,
          y: frame.y,
          width: frame.width ?? FRAME_WIDTH,
          height: (frame.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT,
        },
        { panX, panY, zoom, width: viewportSize.width, height: viewportSize.height },
        FRAME_VIEWPORT_MARGIN,
      ),
    )
    .map(({ frame }) => frame.id)
  // Tagged with the cost too: a trust change, or the dev server coming up,
  // flips the budget under a board that has not panned at all, and the pool
  // has to be recomputed when it does.
  const poolKey = `${frameCost}:${onScreenFrameIds.join('|')}`

  // Advance the retention DURING render, React's documented "adjusting state
  // when something changes" pattern, rather than from an effect.
  //
  // An effect would commit twice per membership change — once with the old
  // pool, once with the new — and `boardFramesLayerRenderScope.test.tsx` and
  // `boardLayerNarrowSelectorsScope.test.tsx` both count commits precisely so
  // this layer cannot quietly start doing that. Setting state during a
  // component's own render makes React discard the in-progress pass and
  // re-run it immediately: one commit, no effect, nothing to tear.
  //
  // `key` is the guard that stops it looping. It is the JOINED on-screen ids
  // (plus the cost), not the array, because a fresh array identity every
  // render would make "did membership change?" always true — and the whole
  // point is that a pan which moved no frame across the margin changes
  // nothing at all.
  let pooledFrameIds = retention.ids
  if (retention.key !== poolKey) {
    const known = new Set(framesWithPages.map(({ frame }) => frame.id))
    const next = nextFramePool(retention.ids, onScreenFrameIds, known, frameCost)
    pooledFrameIds = sameFramePool(retention.ids, next) ? retention.ids : next
    setRetention({ key: poolKey, ids: pooledFrameIds })
  }

  // Marquee drag (WS-7.1) — screen-space rect, portaled outside the
  // transformed layer below. Gesture wiring + arbitration lives in
  // `useMarqueeSelection.ts` (own module, see its doc comment). `layerRef` is
  // both its frame-rect source (it hit-tests each frame's RENDERED box) and
  // its "are we on a studio board?" gate — `.layer` renders in board mode only.
  const layerRef = useRef<HTMLDivElement>(null)
  const marqueeRect = useMarqueeSelection(viewportActions?.canvasRootRef, layerRef)

  if (!hasActiveBoard) return null

  const onScreenFrameIdSet = new Set(onScreenFrameIds)
  // The pool list already leads with every on-screen id (both budgets are
  // `>= onScreenIds.length`, so the truncation can only bite into the
  // retained tail), so this set IS "which frames hold an iframe". A pooled
  // frame is invisible; it is mounted purely so coming back is free.
  const pooledFrameIdSet = new Set(pooledFrameIds)

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
            <AddPagePicker label="Add page" />
          </div>
        </div>
      ) : (
        framesWithPages.map(({ frame, page }) => {
          // Per-frame size (Phase 6E) — a frame without a saved width/height
          // falls back to the shared 1024x800 default, so pre-6E boards.json
          // files render unchanged.
          const width = frame.width ?? FRAME_WIDTH
          const height = frame.height ?? FRAME_HEIGHT
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
              isOnScreen={onScreenFrameIdSet.has(frame.id)}
              isMounted={pooledFrameIdSet.has(frame.id)}
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
