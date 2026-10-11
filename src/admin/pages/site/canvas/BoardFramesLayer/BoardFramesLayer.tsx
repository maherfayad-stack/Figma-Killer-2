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
 * Virtualization + the live set (SB-5, poster-first): a live `BreakpointFrame`
 * (iframe + full `NodeRenderer` tree) is mounted only for the frames in the
 * live set (`liveFrameCap.ts`) — those the user is working in (selected,
 * edited, play), plus the frames in view at zoom >= 0.35, nearest the
 * viewport centre first, up to the adaptive cap (default 20, never below 12,
 * rising with free memory; a Tier-2 board whose dev server is ready has its
 * own, lower cap). There is no margin and no retention: a frame that leaves
 * the live set shows its picture, and `PosterFill` photographs the frames that
 * never had one. See `frameMount.ts` for the vocabulary (`live` / `poster` /
 * `cold`).
 *
 * Frames outside the live set render a static poster body instead — no
 * iframe, no animation. Only the BODY is swapped: the outer `.frame` div,
 * its position (`--frame-x/--frame-y`), the drag header, and its
 * title/rename/context-menu all stay mounted and functional on placeholders
 * too, so position, activation, drag, rename, and removal work regardless of
 * on-screen state. `key={frame.id}` on the list (WS-10 Phase 2 — was
 * `page.id`, which two "duplicate as variant" frames of one page would
 * collide on) ensures React cleanly (re)mounts a fresh iframe when a frame
 * re-enters the viewport, and gives each variant its own component identity.
 *
 * The live set lives in `useState` (not a ref — `react-hooks/refs`,
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
import { useStudioTokenCatalogSync } from '@site/studio/useStudioTokenCatalogSync'
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
import { FRAME_WIDTH, FRAME_HEIGHT, FRAME_HEADER_HEIGHT, type BoardFrame } from '@core/studio-board'
import { isFrameOnScreen, type FrameRect } from './frameVirtualization'
import { sameLiveSet } from './frameMount'
import { POSTER_ZOOM, readLiveCapMemory, selectLiveFrames, type LiveFrameCandidate } from './liveFrameCap'
import { useMeasuredFrameHeights } from './frameMeasuredHeights'
import { PosterFill } from './PosterFill'
import { usePosterFillFrameId } from './posterFillTarget'
import { resolveFramesWithPages } from './resolveFramesWithPages'
import { getStudioTrustTier, subscribeStudioTrustTier } from '@site/studio/studioProjectTrust'
import { useDevServerReadiness } from '@site/studio/useDevServerReadiness'
import { useAdminUi } from '@admin/state/adminUi'
import { useMarqueeSelection } from './useMarqueeSelection'
import { BoardFrameView } from './BoardFrameView'
import { PendingBoardFrame } from './PendingBoardFrame'
import { pendingBoardFrames } from './pendingBoardFrames'
import styles from './BoardFramesLayer.module.css'

// Stable fallback reference — `?? []` inline would hand back a NEW array every
// render, which a Zustand selector must never do (breaks useSyncExternalStore's
// "did this change" check and can spiral into a "Maximum update depth
// exceeded" render loop once anything downstream reacts to the selected value).
const EMPTY_PAGES: (Page | null)[] = []

/** Stable empty live set, for the same "never a fresh literal" reason. */
const EMPTY_LIVE: string[] = []

/**
 * The live set, tagged with the inputs it was derived from. The tag is what
 * lets the derivation happen during render without looping — see the
 * `useState` below.
 */
interface LiveSetState {
  /** The inputs this set was computed for. */
  key: string
  ids: string[]
}

const INITIAL_LIVE: LiveSetState = { key: '\u0000', ids: EMPTY_LIVE }

/**
 * A frame's board-space box, header included. A frame that hugs its content has
 * no stored height: its measured one stands in (`frameMeasuredHeights.ts`), so a
 * tall page whose middle is on screen is in view, not a picture.
 */
function frameRect(frame: BoardFrame, measuredHeights: ReadonlyMap<string, number>): FrameRect {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width ?? FRAME_WIDTH,
    height: (frame.height ?? measuredHeights.get(frame.id) ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT,
  }
}

export function BoardFramesLayer() {
  // CT-4: the frames' mode chips and the gates they apply come from the token
  // catalog; the board keeps it current rather than waiting on the inspector.
  useStudioTokenCatalogSync()
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
    const syncSize = () => {
      // An unlaid-out or hidden canvas measures 0 x 0: keep the last real size rather than
      // reading "nothing is in view" and unmounting every live frame.
      if (root.clientWidth === 0 || root.clientHeight === 0) return
      setViewportSize({ width: root.clientWidth, height: root.clientHeight })
    }
    syncSize()
    const observer = new ResizeObserver(syncSize)
    observer.observe(root)
    return () => observer.disconnect()
  }, [viewportActions])

  // The live set: which frames hold an iframe right now. See `liveFrameCap.ts`
  // for the rule and `frameMount.ts` for what everything else shows.
  const [liveSet, setLiveSet] = useState<LiveSetState>(INITIAL_LIVE)
  // A Tier-2 board whose dev server is READY renders each live frame as a
  // cross-origin document against a real dev-server process, so it gets the
  // bridge cap. Until then — booting, failed, or never started — a Tier-2 frame
  // is its same-origin fallback, exactly what a Tier 0/1 frame is. This is the
  // ONLY place the trust tier touches mounting.
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const devServer = useDevServerReadiness(projectDir)
  const bridge = trust === 'run-project' && devServer.phase === 'ready'
  // The frames the user is working in are live whatever the zoom and the cap:
  // the one holding the selected layer(s) and the one being played.
  const hasNodeSelection = useEditorStore((s) => s.selectedNodeIds.length > 0)
  const selectedNodeFrameId = useEditorStore((s) => s.selectedNodeFrameId)
  const playPageId = useEditorStore((s) => (s.playMode ? (s.playState.screens.at(-1)?.pageId ?? s.activePageId) : null))
  // The one frame `PosterFill` has mounted just to photograph it, if any.
  const fillFrameId = usePosterFillFrameId()
  // How tall each content-hugging frame really is (it decides what is in view).
  const measuredHeights = useMeasuredFrameHeights()

  // Resolved frames, hoisted ABOVE this component's `hasActiveBoard` early
  // return because the live-set derivation below sets state and the hooks
  // around it cannot live after one. Both are cheap array passes over this
  // board's own frames — never a whole-site scan.
  const framesWithPages = resolveFramesWithPages(frames, relevantPages)
  // P6-B — frames whose page a streamed load has not delivered yet hold their
  // place (`PendingBoardFrame`). Empty outside a load, which is every render
  // but the first few of a project opening.
  const pendingPages = useEditorStore((s) => s.pendingPages)
  const pendingFrames = pendingBoardFrames(frames, relevantPages, pendingPages)
  const viewport = { panX, panY, zoom, width: viewportSize.width, height: viewportSize.height }
  const inViewFrameIds = framesWithPages
    .filter(({ frame }) => isFrameOnScreen(frameRect(frame, measuredHeights), viewport, 0))
    .map(({ frame }) => frame.id)
  const selectedFrameIdList = framesWithPages.filter(({ page }) => selectedFrameIds.includes(page.id)).map(({ frame }) => frame.id)
  const editingFrameId = !hasNodeSelection
    ? null
    : framesWithPages.some(({ frame }) => frame.id === selectedNodeFrameId)
      ? selectedNodeFrameId
      : (framesWithPages.find(({ frame }) => frame.pageId === activePageId)?.frame.id ?? null)
  const playFrameId = framesWithPages.find(({ page }) => page.id === playPageId)?.frame.id ?? null
  // Everything the set is derived from, as one string. Panning inside the same
  // in-view membership changes nothing, which is the point: the set is
  // recomputed when the membership, the selection or the zoom class changes,
  // not on every pan commit.
  const liveKey = [
    bridge,
    zoom >= POSTER_ZOOM,
    inViewFrameIds.join('|'),
    selectedFrameIdList.join('|'),
    editingFrameId,
    playFrameId,
  ].join(';')

  // Advance the live set DURING render, React's documented "adjusting state
  // when something changes" pattern, rather than from an effect.
  //
  // An effect would commit twice per membership change — once with the old
  // set, once with the new — and `boardFramesLayerRenderScope.test.tsx` and
  // `boardLayerNarrowSelectorsScope.test.tsx` both count commits precisely so
  // this layer cannot quietly start doing that. Setting state during a
  // component's own render makes React discard the in-progress pass and
  // re-run it immediately: one commit, no effect, nothing to tear.
  //
  // `key` is the guard that stops it looping: it names the INPUTS, so the
  // re-run sees an unchanged key however the new set ranks.
  let liveFrameIds = liveSet.ids
  if (liveSet.key !== liveKey) {
    const candidates = framesWithPages.map(({ frame }): LiveFrameCandidate => {
      const rect = frameRect(frame, measuredHeights)
      const centerX = panX + (rect.x + rect.width / 2) * zoom
      const centerY = panY + (rect.y + rect.height / 2) * zoom
      return {
        id: frame.id,
        inView: inViewFrameIds.includes(frame.id),
        distanceToCenter: Math.hypot(centerX - viewport.width / 2, centerY - viewport.height / 2),
      }
    })
    const { live } = selectLiveFrames({
      ...readLiveCapMemory(bridge),
      frames: candidates,
      zoom,
      selectedFrameIds: new Set(selectedFrameIdList),
      editingFrameId,
      playFrameId,
      retainedIds: new Set(liveSet.ids),
    })
    const next = [...live.keys()]
    liveFrameIds = sameLiveSet(liveSet.ids, next) ? liveSet.ids : next
    setLiveSet({ key: liveKey, ids: liveFrameIds })
  }

  // Marquee drag (WS-7.1) — screen-space rect, portaled outside the
  // transformed layer below. Gesture wiring + arbitration lives in
  // `useMarqueeSelection.ts` (own module, see its doc comment). `layerRef` is
  // both its frame-rect source (it hit-tests each frame's RENDERED box) and
  // its "are we on a studio board?" gate — `.layer` renders in board mode only.
  const layerRef = useRef<HTMLDivElement>(null)
  const marqueeRect = useMarqueeSelection(viewportActions?.canvasRootRef, layerRef)

  if (!hasActiveBoard) return null

  // The set already holds every working frame, in view or not; the fill's one
  // frame rides beside it (it is mounted only to be photographed).
  const liveFrameIdSet = new Set(liveFrameIds)
  if (fillFrameId) liveFrameIdSet.add(fillFrameId)

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
      {framesWithPages.length === 0 && pendingFrames.length === 0 ? (
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
              isLive={liveFrameIdSet.has(frame.id)}
            />
          )
        })
      )}

      {pendingFrames.map(({ frame, title }) => (
        <PendingBoardFrame
          key={frame.id}
          pageId={frame.pageId}
          frameId={frame.id}
          title={title}
          x={frame.x}
          y={frame.y}
          width={frame.width ?? FRAME_WIDTH}
          height={frame.height ?? FRAME_HEIGHT}
        />
      ))}

      <PosterFill liveFrameIds={liveFrameIds} enabled={!bridge} />

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
