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
 */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSlice'
import type { Breakpoint, Page } from '@core/page-tree'
import type { BoardFrame, PreviewAxes } from '@core/studio-board'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { useInlineRename } from '@site/hooks/useInlineRename'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { CanvasFrameContext, CanvasPageContext } from '../CanvasContexts'
import { BreakpointFrame } from '../BreakpointFrame'
import { resizeFrameRect, MIN_FRAME_SIZE, type FrameResizeRect, type ResizeHandle } from './frameResize'
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

/**
 * Every resize handle a frame renders. Cursor-per-handle is a CSS concern
 * (`[data-handle="..."]` selectors in `BoardFramesLayer.module.css`), not a
 * JS-driven inline style.
 */
const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

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
  onActivate: () => void
  onMove: (x: number, y: number) => void
  onResize: (width: number, height: number) => void
  onRemove: () => void
  onRename: (title: string) => void
  /** WS-10 Phase 2 — "duplicate as variant": create a sibling frame of this page with the given axis override. */
  onDuplicateAsVariant: (axes: Partial<PreviewAxes>) => void
}

export function BoardFrameView({
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
  onActivate,
  onMove,
  onResize,
  onRemove,
  onRename,
  onDuplicateAsVariant,
}: BoardFrameViewProps) {
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeDragState | null>(null)
  const [rename, renameInputRef] = useInlineRename({ onCommit: onRename })
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
  const handleActivateCapture = () => {
    if (!isActive) onActivate()
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
              onDuplicateAsVariant({ direction: effectiveAxes.direction === 'rtl' ? 'ltr' : 'rtl' })
            }}
          >
            <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
            Duplicate as {effectiveAxes.direction === 'rtl' ? 'LTR' : 'RTL'}
          </ContextMenuItem>
          {schemeVariantApplies && (
            <ContextMenuItem
              onClick={() => {
                setContextMenu(null)
                onDuplicateAsVariant({ colorScheme: effectiveAxes.colorScheme === 'dark' ? 'light' : 'dark' })
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
                onDuplicateAsVariant({ locale: otherLocale })
              }}
            >
              <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
              Duplicate as {otherLocale?.toUpperCase()}
            </ContextMenuItem>
          )}
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
                onActivate={onActivate}
                frameId={frame.id}
                axesOverride={frame.axes}
              />
            </CanvasFrameContext.Provider>
          </CanvasPageContext.Provider>
        ) : (
          <FramePosterPlaceholder title={page.title} posterUrl={getFramePoster(page, width)} />
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
