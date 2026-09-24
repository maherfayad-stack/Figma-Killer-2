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
import type { Breakpoint, Page } from '@core/page-tree'
import { MIN_FRAME_SIZE, type BoardFrame, type PreviewAxes } from '@core/studio-board'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { useInlineRename } from '@site/hooks/useInlineRename'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { CanvasDiagnosticsScopeContext, CanvasFrameContext, CanvasPageContext } from '../CanvasContexts'
import { BreakpointFrame } from '../BreakpointFrame'
import { CanvasEmptyPageHint } from '../CanvasEmptyPageHint'
import { pageHasNoContent } from '../canvasEmptyPage'
import { RESIZE_HANDLES, type ResizeHandle } from '@core/studio-runtime'
import { resizeRect, type ResizeRect } from '../rectResize'
import { useBoardFrameMoveDrag } from './useBoardFrameMoveDrag'
import { useFramePosterCapture } from './useFramePosterCapture'
import { getFramePoster } from './frameSnapshotCache'
import { FramePosterPlaceholder } from './FramePosterPlaceholder'
import { LiveBoardFrame } from './LiveBoardFrame'
import { resolveFrameMount } from './framePool'
import { FrameDiagnosticsBadge } from './FrameDiagnosticsBadge'
import { describePinnedAxes } from './pinnedAxesLabel'
import {
  getColorSchemeCapability,
  getLocalesCapability,
  subscribeColorSchemeCapability,
  subscribeLocalesCapability,
} from '@site/studio/previewAxesCapability'
import { getStudioTrustTier, subscribeStudioTrustTier } from '@site/studio/studioProjectTrust'
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

/**
 * Interned per width, because the RESULT is a prop.
 *
 * `BreakpointFrame` is `memo()`'d (its own React-Compiler-exception comment
 * says why), and a fresh object literal here would defeat that bailout on
 * every single render of every frame — the memo would compare a new
 * `Breakpoint` identity each time and re-render the whole frame subtree.
 * A board settles on a handful of distinct widths, but a RESIZE DRAG walks
 * through one width per pointer move, so the map is capped rather than left to
 * grow with the drag. Nothing shares a `Breakpoint` mutably — every consumer
 * only reads `width`/`label`/`mediaQuery`/`id`.
 */
const STUDIO_BREAKPOINT_CACHE_LIMIT = 64
const studioBreakpointsByWidth = new Map<number, Breakpoint>()

/**
 * Interned per page id, for the same reason `buildStudioBreakpoint` is
 * interned per width: this is the `onActivate` PROP of a `memo()`'d
 * `BreakpointFrame`, so a fresh closure per render would defeat the bailout.
 *
 * Deliberately not left to the React Compiler. The compiler would memoize the
 * closure inside the component, but it does not run in `bun test`, and the
 * bailout this feeds is a documented React-Compiler EXCEPTION precisely
 * because it is a different mechanism — so the prop identity that exception
 * depends on should not itself depend on the compiler. The handler closes over
 * nothing but the page id (the store is read imperatively at call time), so
 * one instance per page is correct forever.
 */
const activateHandlersByPageId = new Map<string, () => void>()

function activatePageHandler(pageId: string): () => void {
  const cached = activateHandlersByPageId.get(pageId)
  if (cached) return cached
  const handler = () => useEditorStore.getState().openPageInCanvas(pageId)
  activateHandlersByPageId.set(pageId, handler)
  return handler
}

/** This frame's synthetic breakpoint, sized to ITS OWN board width. */
function buildStudioBreakpoint(width: number): Breakpoint {
  const cached = studioBreakpointsByWidth.get(width)
  if (cached) return cached
  if (studioBreakpointsByWidth.size >= STUDIO_BREAKPOINT_CACHE_LIMIT) studioBreakpointsByWidth.clear()
  const breakpoint: Breakpoint = { ...STUDIO_BREAKPOINT_BASE, width }
  studioBreakpointsByWidth.set(width, breakpoint)
  return breakpoint
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
  /**
   * Whether this frame's board rect intersects the viewport (plus margin). It
   * drives the frozen-poster CAPTURE only — the picture has to be taken while
   * the frame is genuinely on screen and settled.
   */
  isOnScreen: boolean
  /**
   * Whether the mount pool (`framePool.ts`) is holding this frame. A
   * superset of `isOnScreen`: the pool keeps recently-departed frames
   * mounted so panning back to them costs nothing. A pooled, offscreen frame
   * is simply outside the visible area — it renders exactly as it did on
   * screen, it just isn't being looked at. The budget that decided this is
   * the board's, not this component's: one pool, sized by what a frame costs
   * on this tier.
   *
   * Optional, defaulting to `isOnScreen` (through `resolveFrameMount`): a
   * caller that does not take part in the pool — a unit test, or any future
   * surface rendering one frame outside `BoardFramesLayer` — means "mounted
   * exactly while visible", which is the pre-pool behaviour and the only
   * honest default. Required here once, it silently unmounted every such
   * caller (`meta-14` landmine 1; `boardFrameViewTierFork.test.tsx` is the
   * gate).
   */
  isMounted?: boolean
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
  isMounted,
}: BoardFrameViewProps) {
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  // ONE module answers "does this frame hold an iframe, and why"
  // (`framePool.ts`). The tier no longer enters here at all: it picked the
  // pool's budget back in `BoardFramesLayer`, which is the only place a
  // frame's cost is a question. `reason` is stamped on the frame element
  // below so the answer is legible from the DOM.
  const { mounted, reason: mountReason } = resolveFrameMount({ isOnScreen, isPooled: isMounted })
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
  // Header badge — the ONLY thing that makes a pinned frame visibly
  // different from an unpinned one (see `pinnedAxesLabel.ts`'s doc). `null`
  // whenever `frame.axes` is absent or empty, so an ordinary frame renders
  // no badge at all rather than an empty one.
  const pinnedAxesLabel = describePinnedAxes(frame.axes)
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
  // S1 — the frame's mount is staged (iframe -> injectors -> node tree; see
  // `IframeFrameSurface`'s header), so between entering the viewport and the
  // tree's commit the iframe is a real but EMPTY document. The poster stays
  // painted on top of it until then, which is what makes a zoom-out read as
  // "these frames were always there" instead of a wave of white boxes.
  // `setContentReady` is passed down raw: a `useState` setter's identity is
  // stable by React's own contract, so it cannot defeat `BreakpointFrame`'s
  // `memo()` bailout the way a fresh closure would.
  const [contentReady, setContentReady] = useState(false)

  // Capture phase — fires before the frame's own node-click handling, so
  // `activePageId` is already switched to this page by the time selection
  // logic runs (see the module doc's "Activation + edit routing" note).
  const activatePage = activatePageHandler(page.id)

  const handleActivateCapture = () => {
    if (!isActive) activatePage()
  }

  // The header move-drag, end to end (press, snap, Alt-copy, Escape,
  // release) — its own hook so this view keeps owning what a frame LOOKS
  // like. See `useBoardFrameMoveDrag`.
  const moveDrag = useBoardFrameMoveDrag({ frameId: frame.id, pageId: page.id, x, y, width, height })

  const handleHeaderContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
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
  /**
   * `canvas-16` — the inverse of "duplicate as variant": clears this frame's
   * OWN axes override so it goes back to following the board/toolbar preview
   * axes. Goes through the same `setFrameAxes` store action every MCP write
   * uses (`boardFrameSliceActions.ts`), so it lands on the same undo stack
   * and autosave (`commitBoardChange`) as every other frame mutation — no
   * second write path.
   */
  const handleResetAxes = () => useEditorStore.getState().setFrameAxes(frame.id, undefined)

  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) {
      resizeRef.current = null
      useEditorStore.getState().endBoardGesture()
    }
  }

  return (
    // `data-frame-mount` is `FRAME_MOUNT_ATTR` spelled out — JSX cannot take
    // a computed attribute name without a spread. The two spellings are tied
    // together by `framePoolMountReason.test.tsx`, which reads this element
    // back through `readFrameMountReason`.
    <div
      className={styles.frame}
      data-page-id={page.id}
      data-frame-id={frame.id}
      data-frame-mount={mountReason}
      data-active={isActive ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      style={{ '--frame-x': `${x}px`, '--frame-y': `${y}px` } as CSSProperties}
      onPointerDownCapture={handleActivateCapture}
    >
      <div
        className={styles.header}
        data-testid="board-frame-header"
        onPointerDown={moveDrag.onPointerDown}
        onPointerMove={moveDrag.onPointerMove}
        onPointerUp={moveDrag.onPointerUp}
        onPointerCancel={moveDrag.onPointerUp}
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
        {/* `canvas-16` — this frame carries its OWN preview-axes override
            (`frame.axes`), which always wins over the board/toolbar axes
            (see `effectiveAxes` above). Without this badge a pinned frame is
            indistinguishable from an unpinned one, and the toolbar silently
            stops explaining what's on screen. Shown next to the title in
            BOTH states (renaming or not) so the pin doesn't disappear mid-
            rename; `flex-shrink: 0` keeps it from being squeezed by a long
            title/rename input, which truncates instead (`.title`'s own
            `min-width: 0`). */}
        {pinnedAxesLabel && (
          <span
            className={styles.axesBadge}
            data-testid="board-frame-axes-badge"
            title={`This frame is pinned to ${pinnedAxesLabel} — it ignores the board's preview toolbar`}
          >
            {pinnedAxesLabel}
          </span>
        )}
        {/* Z5 — this frame's runtime said something went wrong. Renders
            nothing at all until it did; never a toast. Both tiers publish
            under this frame's id (a Tier-0 portal frame through
            `CanvasDiagnosticsInjector`, a Tier-2 live one through
            `useBridgeFrameDiagnostics`), so the badge does not branch on
            trust. */}
        <FrameDiagnosticsBadge scopeKey={frame.id} />
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
          {/* `canvas-16` — the inverse of every "Duplicate as …" item above:
              clears this frame's own override so it goes back to following
              the board/toolbar preview axes. Omitted (not disabled) when
              there is nothing to reset, matching the omission convention the
              variant items above already use — never a dead item on an
              unpinned frame. */}
          {frame.axes && (
            <ContextMenuItem
              data-testid="board-frame-reset-axes"
              onClick={() => { setContextMenu(null); handleResetAxes() }}
            >
              Follow board preview axes
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
          `BoardFramesLayer.module.css`). Gated on `mounted` too: a
          frame with no live iframe has nothing to size against, so it keeps
          the fixed fallback box the placeholder needs — same as before. */}
      <div
        ref={frameBodyRef}
        className={styles.frameBody}
        data-testid="board-frame-body"
        data-frame-auto-height={!hasManualHeight && mounted ? 'true' : undefined}
        style={{ '--frame-w': `${width}px`, '--frame-h': `${height}px` } as CSSProperties}
      >
        {/* `CanvasDiagnosticsScopeContext` (Z5) is where this frame's runtime
            diagnostics are published, so the header badge above can subscribe
            to them. Separate from `CanvasFrameContext` on purpose — see that
            context's own doc. */}
        {mounted ? (
          <CanvasDiagnosticsScopeContext.Provider value={frame.id}>
            <CanvasPageContext.Provider value={page.id}>
              {/* WS-10 Phase 2 — this frame's OWN id, so NodeRenderer can tag
                  every selection/hover it originates with the frame it came
                  from (`selectedNodeFrameId`/`hoveredFrameId`). Without this a
                  "duplicate as variant" sibling of this page — sharing every
                  node id (trap #2) — would light up from a selection made in
                  THIS frame. See `CanvasFrameContext`'s doc. */}
              <CanvasFrameContext.Provider value={frame.id}>
                {trust === 'run-project' ? (
                  // L8 Phase A (`perf-06`, STATE.md) — the ONE Tier-2 branch
                  // this whole work order adds. Tier 0/1 boards never reach
                  // this line: `trust` only ever reads `'run-project'` for a
                  // project explicitly promoted to Tier 2.
                  <LiveBoardFrame
                    page={page}
                    breakpoint={buildStudioBreakpoint(width)}
                    isActive={isActive}
                    onActivate={activatePage}
                    frameId={frame.id}
                    axesOverride={frame.axes}
                    width={width}
                  />
                ) : (
                  // Byte-for-byte the SAME call this branch has always made —
                  // no new prop, no new behavior, for every Tier 0/1 board.
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
                    onContentReadyChange={setContentReady}
                  />
                )}
              </CanvasFrameContext.Provider>
            </CanvasPageContext.Provider>
          </CanvasDiagnosticsScopeContext.Provider>
        ) : (
          <FramePosterPlaceholder title={page.title} posterUrl={getFramePoster(page, width)} />
        )}
        {/* The poster stays painted over a portal frame until its tree has
            committed. A Tier-2 frame reports no such readiness — it draws its
            own boot and crash chrome (`LiveBoardFrame`) — so an overlay there
            would be a poster that never lifts. */}
        {mounted && trust !== 'run-project' && !contentReady && (
          <FramePosterPlaceholder title={page.title} posterUrl={getFramePoster(page, width)} overlay />
        )}
        {/* A page with nothing on it renders as a blank rectangle, which reads
            as "it did not load". Only for a frame that is actually drawing its
            iframe: an offscreen frame is showing a poster, and a caption over
            that would be about a page nobody can see. */}
        {mounted && pageHasNoContent(page) && <CanvasEmptyPageHint pageId={page.id} />}
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
