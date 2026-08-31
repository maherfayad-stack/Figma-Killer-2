/**
 * `BoardFrameView` — a single studio board frame: header (drag handle,
 * rename, context menu), resize handles, and its live `BreakpointFrame` /
 * offscreen poster placeholder body. Extracted out of `BoardFramesLayer.tsx`
 * (module-size-budgets gate) — this is the one frame renderer, mounted once
 * per entry in `BoardFramesLayer`'s `framesWithPages` list. No behavior
 * changed by the extraction; see `BoardFramesLayer.tsx`'s module doc for the
 * board-level concerns (frame membership, virtualization, activation
 * routing, drag-to-reposition) this component's own doc comments below cross
 * reference.
 *
 * `memo()`'d (React Compiler exception #2 — a hot, list-rendered component;
 * see `NodeRenderer.tsx`'s identical justification): a 15-frame board's
 * `BoardFramesLayer` re-renders on every board write, and without this every
 * frame's OWN `BreakpointFrame` + iframe would re-render with it. This only
 * pays off because every prop below is either a primitive or traces back to
 * `frame`/`page` object references that `boardsModel.ts`'s per-collection
 * transforms deliberately keep stable for every UNAFFECTED frame (copy-on-
 * write replaces only the touched array element, `.map()`-preserving every
 * other one) — see `boardSlice.ts`'s `selectActiveBoardFrames` doc. Mutating
 * actions (`setFramePosition`, `setFrameSize`, `removeFrameById`, …) are
 * called directly against `useEditorStore.getState()` from inside this
 * component rather than threaded down as parent-bound closures, precisely so
 * this file never has to depend on a `.map()` callback producing a stable
 * closure identity to make the `memo()` bailout real.
 */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  memo,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import type { Breakpoint, Page } from '@core/page-tree'
import { MIN_FRAME_SIZE, type BoardFrame, type PreviewAxes } from '@core/studio-board'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { useInlineRename } from '@site/hooks/useInlineRename'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { CanvasFrameContext, CanvasPageContext } from '../CanvasContexts'
import { BreakpointFrame } from '../BreakpointFrame'
import { resizeRect, RESIZE_HANDLES, type ResizeRect, type ResizeHandle } from '../rectResize'
import { computeSnap, collectPeerRects, SNAP_THRESHOLD_BOARD_UNITS } from '../boardSnapping'
import { useFramePosterCapture } from './useFramePosterCapture'
import { getFramePoster } from './frameSnapshotCache'
import { FramePosterPlaceholder } from './FramePosterPlaceholder'
import {
  getColorSchemeCapability,
  getLocalesCapability,
  subscribeColorSchemeCapability,
  subscribeLocalesCapability,
} from '@site/studio/previewAxesCapability'
import styles from './BoardFramesLayer.module.css'

/**
 * Shared chrome every studio frame's synthetic breakpoint carries — see
 * `BoardFramesLayer.tsx`'s "KNOWN LIMITATION" note for what per-frame chrome
 * this costs. Only `width` varies per frame (Phase 6E — resizable frames);
 * each frame builds its own `Breakpoint` below instead of sharing one
 * hardcoded 1024px width.
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
  /** The frame's full rect at drag-start — the pure `resizeRect` anchor. */
  anchor: ResizeRect
}

interface BoardFrameViewProps {
  /** WS-10 Phase 2 — the frame's own identity + its per-axis preview override, if any. See `types.ts`'s `BoardFrame` doc. */
  frame: BoardFrame
  page: Page
  x: number
  y: number
  /** This frame's own board-space size — Phase 6E (falls back to
   * `FRAME_WIDTH`/`FRAME_HEIGHT` upstream in `BoardFramesLayer`, so this
   * component always receives a concrete size). */
  width: number
  height: number
  /**
   * Whether `height` above came from a persisted, author-dragged resize
   * (`board.frames[].height` is set) rather than the `FRAME_HEIGHT` default
   * (`canvas-04`). Drives `.frameBody`'s auto-vs-fixed sizing — see the
   * `data-frame-auto-height` usage below and `BoardFramesLayer.module.css`.
   */
  hasManualHeight: boolean
  isActive: boolean
  /** WS-7.1 — whether this frame is part of the bulk-selection set (`selectedFrameIds`). Distinct from `isActive`. */
  isSelected: boolean
  isOnScreen: boolean
}

/**
 * A plain functional component, wrapped in `memo()` at the bottom export —
 * every callback this used to receive as a parent-bound prop (`onActivate`,
 * `onMove`, `onResize`, `onResetHeight`, `onRemove`, `onRename`,
 * `onDuplicateAsVariant`) now calls the matching store action directly
 * against `useEditorStore.getState()` using this component's own `frame`/
 * `page` props, so the `memo()` bailout below doesn't depend on
 * `BoardFramesLayer`'s `.map()` producing stable closures per frame — see
 * this module's top doc comment.
 */
function BoardFrameViewImpl({
  frame,
  page,
  x,
  y,
  width,
  height,
  hasManualHeight,
  isActive,
  isSelected,
  isOnScreen,
}: BoardFrameViewProps) {
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeDragState | null>(null)
  const [rename, renameInputRef] = useInlineRename({
    onCommit: (title) => useEditorStore.getState().renamePage(page.id, title),
  })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  // WS-10 Phase 2 — "duplicate as variant" flips whichever axis it targets
  // relative to what this frame is ACTUALLY previewing right now (its own
  // override merged onto the board default), never the raw board default —
  // otherwise duplicating an already-overridden RTL frame "as RTL" would be
  // a no-op flip instead of producing the LTR sibling the label promises.
  const boardAxes = useEditorStore((s) => s.previewAxes)
  const effectiveAxes: PreviewAxes = { ...boardAxes, ...frame.axes }
  const colorSchemeCapability = useSyncExternalStore(
    subscribeColorSchemeCapability,
    getColorSchemeCapability,
    getColorSchemeCapability,
  )
  const schemeVariantApplies = colorSchemeCapability !== null && colorSchemeCapability.mechanism !== 'none'
  // WS-10 §4.4 (Phase 4) — locale duplicate variant, same probe-honesty gate
  // (§7.4) the scheme variant above uses: omitted (not disabled) when the
  // probe found no locale dictionary at all, or found only one locale (a
  // duplicate would look identical to its source).
  const localesCapability = useSyncExternalStore(subscribeLocalesCapability, getLocalesCapability, getLocalesCapability)
  const currentLocale = effectiveAxes.locale ?? localesCapability?.defaultKey ?? localesCapability?.keys[0]
  const otherLocale = localesCapability?.keys.find((k) => k !== currentLocale)
  const localeVariantApplies = Boolean(otherLocale)

  // WS-10 §4.4 (Phase 4) — the fetch trigger: a frame whose OWN locale
  // differs from the board default needs its `(pageId, locale)` tree from
  // `localizedPageSlice.ts` before it can render correctly.
  // `ensureLocalizedPage` no-ops once fetched (or already loading), so this
  // effect firing on every render of every frame costs nothing once
  // steady-state. A frame whose locale did NOT change never enters this
  // branch at all — no fetch, no re-render source, nothing to remount.
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const ensureLocalizedPage = useEditorStore((s) => s.ensureLocalizedPage)
  useEffect(() => {
    if (!projectDir || !frame.axes?.locale || frame.axes.locale === boardAxes.locale) return
    void ensureLocalizedPage(projectDir, frame.pageId, frame.axes.locale)
  }, [projectDir, frame.pageId, frame.axes?.locale, boardAxes.locale, ensureLocalizedPage])
  // WS-5.3 — frozen poster for this frame's offscreen placeholder. Capture
  // reads the live iframe straight out of `frameBodyRef` while on screen; see
  // `useFramePosterCapture.ts`'s own doc comment for why it doesn't mount a
  // second offscreen frame to do this.
  const frameBodyRef = useRef<HTMLDivElement>(null)
  useFramePosterCapture(frameBodyRef, page, width, isOnScreen)

  // Capture phase — fires before the frame's own node-click handling, so
  // `activePageId` is already switched to this page by the time selection
  // logic runs (see the module doc's "Activation + edit routing" note).
  const activatePage = () => useEditorStore.getState().openPageInCanvas(page.id)

  const handleActivateCapture = () => {
    if (!isActive) activatePage()
  }

  const handleHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only the primary (left) button starts a move-drag — a right-click's
    // pointerdown must fall through to `onContextMenu` untouched, never
    // arming drag state (see the module doc's "Drag-to-reposition" note).
    if (e.button !== 0) return
    // WS-7.1 — select on pointerDOWN (not click/mouseup), matching Figma:
    // pressing a frame's header selects it immediately, and a drag that
    // follows moves the now-selected frame. Plain click replaces the
    // selection; Shift-click extends it (toggle-add).
    useEditorStore.getState().selectFrame(page.id, e.shiftKey ? 'toggle' : 'replace')
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
    useEditorStore.getState().setFramePosition(frame.id, snapped.x, snapped.y)
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
  // `resizeRect` — this handler only converts screen pixels to board units
  // and applies the result via `setFrameRect`, ONE combined position+size
  // store write per tick (a corner/edge handle can move x/y AND w/h in the
  // same gesture; two separate `setFramePosition`+`setFrameSize` calls used
  // to mean two `Board` reallocations and two selector sweeps per tick for
  // one drag).
  const handleResizePointerDown = (handle: ResizeHandle) => (e: ReactPointerEvent<HTMLDivElement>) => {
    // A handle sits inside the frame's own pointerdown-capture region — stop
    // it reaching `handleActivateCapture`/the header's drag handlers so
    // grabbing a handle never also starts a move-drag.
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    // A hugging frame's `height` prop is the FALLBACK default, not what is on
    // screen — the box grew to fit its iframe. Anchoring a vertical drag on
    // the prop would snap the frame to that default the instant the pointer
    // moved. Measure the box instead (screen px ÷ zoom = board units).
    const zoom = useEditorStore.getState().zoom
    const measured = frameBodyRef.current?.getBoundingClientRect().height
    const anchorHeight = !hasManualHeight && measured ? measured / zoom : height
    resizeRef.current = {
      pointerId: e.pointerId,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      anchor: { x, y, width, height: anchorHeight },
    }
  }

  const handleResizePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const zoom = useEditorStore.getState().zoom
    const dx = (e.clientX - drag.startClientX) / zoom
    const dy = (e.clientY - drag.startClientY) / zoom
    const next = resizeRect(drag.anchor, drag.handle, dx, dy, MIN_FRAME_SIZE)
    // Only a handle that actually moves a horizontal edge is "I chose this
    // height". Dragging `e`/`w` used to commit the resolved fallback height as
    // if the author had picked it, which silently turned auto-hug off on a
    // frame the author had only made wider.
    const changesHeight = drag.handle.includes('n') || drag.handle.includes('s')
    useEditorStore.getState().setFrameRect(
      frame.id,
      next.x,
      next.y,
      next.width,
      changesHeight || hasManualHeight ? next.height : undefined,
    )
  }

  /** Clears the stored height so the frame hugs its content again. */
  const handleResetHeight = () => useEditorStore.getState().setFrameSize(frame.id, width, undefined)
  const handleRemove = () => useEditorStore.getState().removeFrameById(frame.id)
  /** WS-10 Phase 2 — "duplicate as variant": create a sibling frame of this page with the given axis override. */
  const handleDuplicateAsVariant = (axes: Partial<PreviewAxes>) =>
    useEditorStore.getState().duplicateFrameAsVariant(frame.id, axes)

  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) resizeRef.current = null
  }

  return (
    <div
      className={styles.frame}
      data-page-id={page.id}
      data-frame-id={frame.id}
      data-active={isActive ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      style={{ '--frame-x': `${x}px`, '--frame-y': `${y}px` } as CSSProperties}
      onPointerDownCapture={handleActivateCapture}
    >
      <div
        className={styles.header}
        data-testid="board-frame-header"
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
            ref={renameInputRef}
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
          {/* WS-10 Phase 2 (§4.3-§4.4) — "duplicate as variant": a second
              frame of the SAME page, beside this one, with one preview axis
              flipped. Direction always applies (no probe gate — `dir`
              always works, same as the toolbar toggle); the color-scheme
              variant is omitted (not disabled) when the probe found no
              dark-mode mechanism, so the menu never offers a duplicate that
              would look identical to its source. */}
          <ContextMenuItem
            onClick={() => {
              setContextMenu(null)
              handleDuplicateAsVariant({ direction: effectiveAxes.direction === 'rtl' ? 'ltr' : 'rtl' })
            }}
          >
            <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
            Duplicate as {effectiveAxes.direction === 'rtl' ? 'LTR' : 'RTL'}
          </ContextMenuItem>
          {schemeVariantApplies && (
            <ContextMenuItem
              onClick={() => {
                setContextMenu(null)
                handleDuplicateAsVariant({ colorScheme: effectiveAxes.colorScheme === 'dark' ? 'light' : 'dark' })
              }}
            >
              <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
              Duplicate as {effectiveAxes.colorScheme === 'dark' ? 'Light' : 'Dark'}
            </ContextMenuItem>
          )}
          {localeVariantApplies && (
            <ContextMenuItem
              onClick={() => {
                setContextMenu(null)
                handleDuplicateAsVariant({ locale: otherLocale })
              }}
            >
              <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
              Duplicate as {otherLocale?.toUpperCase()}
            </ContextMenuItem>
          )}
          {hasManualHeight && (
            <ContextMenuItem onClick={() => { setContextMenu(null); handleResetHeight() }}>
              Fit height to content
            </ContextMenuItem>
          )}
          <ContextMenuItem
            danger
            onClick={() => { setContextMenu(null); handleRemove() }}
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
          on-screen state. Content taller than `height` scrolls inside —
          UNLESS the frame has never been manually resized, in which case
          `data-frame-auto-height` (canvas-04) lets the box grow to wrap its
          already-correctly-fitted iframe instead (see
          `BoardFramesLayer.module.css`). Gated on `isOnScreen` too: an
          offscreen frame has no live iframe to size against, so it keeps the
          fixed fallback box the placeholder needs — same as before. */}
      <div
        ref={frameBodyRef}
        className={styles.frameBody}
        data-testid="board-frame-body"
        data-frame-auto-height={!hasManualHeight && isOnScreen ? 'true' : undefined}
        style={{ '--frame-w': `${width}px`, '--frame-h': `${height}px` } as CSSProperties}
      >
        {isOnScreen ? (
          <CanvasPageContext.Provider value={page.id}>
            {/* WS-10 Phase 2 — this frame's OWN id, so NodeRenderer can tag
                every selection/hover it originates with the frame it came
                from (`selectedNodeFrameId`/`hoveredFrameId`). Without this a
                "duplicate as variant" sibling of this page — sharing every
                node id (trap #2) — would light up from a selection made in
                THIS frame. See `CanvasFrameContext`'s doc. */}
            <CanvasFrameContext.Provider value={frame.id}>
              <BreakpointFrame
                page={page}
                breakpoint={buildStudioBreakpoint(width)}
                isActive={isActive}
                onActivate={activatePage}
                frameId={frame.id}
                axesOverride={frame.axes}
                // The board frame carries its own header (title, rename,
                // context menu, drag handle) and its own size in the
                // Properties panel, so `BreakpointFrame`'s breakpoint row
                // would be a second, board-global chrome strip on top of it.
                // See `showBreakpointChrome`'s doc on `BreakpointFrame`.
                showBreakpointChrome={false}
              />
            </CanvasFrameContext.Provider>
          </CanvasPageContext.Provider>
        ) : (
          <FramePosterPlaceholder title={page.title} posterUrl={getFramePoster(page, width)} />
        )}
      </div>
      {/* Resize handles — SELECTED frames only, not merely active.
          `activePageId` is the edit target: it is set by a capture-phase click
          anywhere inside a frame and is never cleared, so gating on it left
          handles (and, before this change, a ring) permanently drawn around
          the last frame the user happened to touch — indistinguishable from a
          selection that could not be dismissed. Resizing is something you do
          to what you SELECTED, so the handles follow `selectedFrameIds`, which
          a background click, Escape, or a marquee all clear.
          Corners resize both axes; edges resize one. See rectResize.ts. */}
      {isSelected && (
        <div className={styles.resizeHandles} aria-hidden="true">
          {RESIZE_HANDLES.map((handle) => (
            <div
              key={handle}
              className={styles.resizeHandle}
              data-handle={handle}
              data-testid={`board-frame-resize-${handle}`}
              // Double-clicking the BOTTOM edge clears the stored height, so
              // the frame goes back to hugging its content — the standard
              // "double-click a sizing edge to fit" gesture. Only on `s`: it
              // is the edge that reads as "the bottom of the page", and a
              // corner double-click would be ambiguous about which axis it
              // meant. The same action is in the frame's context menu, which
              // is the discoverable and keyboard-reachable path (these handles
              // sit in an `aria-hidden` container).
              title={handle === 's' && hasManualHeight ? 'Double-click to fit height to content' : undefined}
              onDoubleClick={handle === 's' ? handleResetHeight : undefined}
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

export const BoardFrameView = memo(BoardFrameViewImpl)
