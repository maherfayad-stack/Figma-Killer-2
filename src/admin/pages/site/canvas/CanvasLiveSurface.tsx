/**
 * CanvasLiveSurface — the single real-size editable frame shown when
 * canvasView is 'live'.
 *
 * This replaces the design canvas's pan/zoom multi-breakpoint layer with ONE
 * frame at 100% size, scrolling normally — like a conventional visual editor's
 * live view. Crucially it is NOT a read-only preview: it reuses the very same
 * editable iframe (`IframeFrameSurface`) and selection overlay the design
 * canvas uses, so click-to-select, the properties panel, and structural edits
 * all keep working here. The only differences from a design frame are layout
 * (single, real-size, internally scrolling) and the absence of pan/zoom.
 *
 * Width model ("fluid + presets"):
 * - The frame fills the available surface width by default (fluid).
 * - Picking a narrower breakpoint in the toggle clamps the frame to that
 *   breakpoint's width, centred, to test responsiveness. `computeNaturalWidth`
 *   resolves this as `min(breakpoint.width, containerWidth)`.
 * - Side handles let the author fine-tune the width continuously between the
 *   minimum and the breakpoint's natural width.
 *
 * Runtime scripts: when the "Run scripts" toggle is on, CanvasRoot passes the
 * bundled scripts down via `runtimeScripts`; they execute inside this frame
 * just as they do in the design frames.
 *
 * Loading: while the page / breakpoints are still hydrating, the surface
 * renders the shared `CanvasFrameSkeleton` inside the live frame's width
 * model — the same treatment the design canvas's `CanvasTransformLayer`
 * gives a null page, so both views load consistently.
 */

import {
  use,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Breakpoint, Page } from '@core/page-tree'
import type { PrototypeTransition } from '@core/studio-prototype'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { CanvasComposedTree } from './CanvasComposedTree'
import { BreakpointSelectionOverlay } from './BreakpointSelectionOverlay'
import {
  CanvasBreakpointContext,
  CanvasDocumentContext,
  CanvasPageContext,
  CanvasTemplateContext,
} from './CanvasContexts'
import { IframeFrameSurface, type IframeFrameSurfaceHandle } from './IframeFrameSurface'
import { DeviceMockup } from './DeviceMockup'
import { PrototypeOverlay } from './PrototypeOverlay'
import { PrototypeScreenStack } from './PrototypeScreenStack'
import { DeviceScrollbarInjector } from './DeviceScrollbarInjector'
import { DEVICE_BEZEL_PX, resolveDeviceKind, type DeviceKind } from './deviceKind'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import { CanvasFrameSkeleton } from '@admin/shared/CanvasFrameSkeleton'
import styles from './CanvasLiveSurface.module.css'

/**
 * The user-resize override is scoped to a specific breakpoint id. Switching
 * breakpoints invalidates a previous override automatically (the derivation
 * just ignores it), so the frame snaps back to the new breakpoint's natural
 * width without a useEffect.
 */
interface LiveWidthOverride {
  breakpointId: string
  width: number
}

interface CanvasLiveSurfaceProps {
  page: Page | null
  /**
   * The prototype overlay presented on top of `page`, or null. Only ever set
   * while the player is armed — an overlay is a PLAYER concept, not an editing
   * one, and the editing surface has no equivalent.
   */
  overlayPage?: Page | null
  /** How the overlay arrived, for its entrance animation. */
  overlayTransition?: PrototypeTransition | null
  /** How the overlay that just left was presented, for its exit animation. */
  overlayLeaveTransition?: PrototypeTransition | null
  /** How the current screen arrived, when no overlay is on top of it. */
  screenTransition?: PrototypeTransition | null
  /**
   * The player is armed. Mounts the two-slot screen stack: a navigation has an
   * outgoing screen to animate, which editing never does.
   */
  playMode?: boolean
  activeBreakpoint: Breakpoint | null
  templateContext?: TemplateRenderDataContext
  runtimeScripts?: InjectableRuntimeScript[]
}

/** Hard floor on the frame width so it can't be shrunk into nothing. */
const LIVE_MIN_WIDTH = 240

/** One pixel of pointer travel changes the visible width by 2 (symmetric). */
const SYMMETRIC_DRAG_FACTOR = 2

interface ResizeDragState {
  startClientX: number
  startWidth: number
  side: 'left' | 'right'
}

export function CanvasLiveSurface({
  page,
  overlayPage = null,
  overlayTransition = null,
  overlayLeaveTransition = null,
  screenTransition = null,
  playMode = false,
  activeBreakpoint,
  templateContext,
  runtimeScripts,
}: CanvasLiveSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ResizeDragState | null>(null)

  // Outer viewport `<div>` wrapping the iframe — the selection overlay measures
  // it for positioning context, and queries the iframe element for node rects.
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null)
  // Always `null` here in practice — `CanvasSelectionOverlayInjector` is
  // design-mode only (WS-5.1), so a live-interaction `IframeFrameSurface`
  // never creates one. Tracked (rather than passing a literal `null`) so this
  // stays correct automatically if that ever changes; `BreakpointSelectionOverlay`
  // already falls back to its pre-WS-5.1 rendering whenever this is `null`.
  const [overlayRoot, setOverlayRoot] = useState<HTMLDivElement | null>(null)

  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const [widthOverride, setWidthOverride] = useState<LiveWidthOverride | null>(null)

  useEffect(() => {
    const node = surfaceRef.current
    if (!node) return
    const update = () => setContainerWidth(node.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  /**
   * One screen's frame. Shared by the single editing slot and both player
   * slots so a screen cannot render differently depending on which one holds
   * it. `iframeRef` is only passed by the editing slot — the selection overlay
   * measures against that iframe, and the player has no selection.
   */
  const renderScreen = (screenPage: Page, iframeRef?: typeof handleIframeRef): ReactNode => (
    <IframeFrameSurface
      ref={iframeRef}
      interaction="live"
      breakpointId={activeBreakpoint?.id ?? ''}
      width={activeBreakpoint?.width ?? 0}
      runtimeScripts={runtimeScripts}
    >
      {/*
        `NodeRenderer` resolves every node id against the page named by
        `CanvasPageContext`, falling back to the ACTIVE document when there is
        none — which is why the live frame worked for as long as it only ever
        showed the page being edited. The player shows a different one, and
        without this provider every id it asked for was looked up in the wrong
        tree, found nothing, and rendered an empty device. Each board frame
        provides its own id for exactly this reason.
      */}
      {/*
        Inside the frame, not beside it. A phone draws no scrollbar, and the
        surface used to hide them through a ref only the EDITING slot published
        — so the player's two screen slots and the presented overlay, the three
        frames a prototype is actually made of, each kept theirs. Mounted here,
        every frame this surface builds is covered by construction.
      */}
      <FrameScrollbars hidden={deviceKind !== null} />
      <CanvasPageContext.Provider value={screenPage.id}>
        <CanvasTemplateContext.Provider value={templateContext}>
          <CanvasBreakpointContext.Provider value={activeBreakpoint?.id ?? ''}>
            <CanvasComposedTree page={screenPage} />
          </CanvasBreakpointContext.Provider>
        </CanvasTemplateContext.Provider>
      </CanvasPageContext.Provider>
    </IframeFrameSurface>
  )

  const deviceKind = resolveDeviceKind(activeBreakpoint)
  const naturalWidth = computeNaturalWidth(activeBreakpoint, containerWidth, deviceKind)
  const effectiveMaxWidth = naturalWidth ?? containerWidth ?? null
  const effectiveWidth =
    activeBreakpoint && widthOverride?.breakpointId === activeBreakpoint.id
      ? widthOverride.width
      : naturalWidth

  // useCallback kept: react-hooks/refs escape hatch — dragRef.current is read/
  // written in event handlers; a plain render-scoped function trips the
  // "ref access during render" lint rule.
  const handlePointerDown = useCallback(
    (side: 'left' | 'right') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (effectiveWidth === null || !activeBreakpoint) return
      dragRef.current = { startClientX: event.clientX, startWidth: effectiveWidth, side }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [effectiveWidth, activeBreakpoint],
  )

  // useCallback kept: react-hooks/refs escape hatch (see handlePointerDown).
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || !activeBreakpoint) return
      const max = effectiveMaxWidth ?? drag.startWidth
      setWidthOverride({
        breakpointId: activeBreakpoint.id,
        width: computeResizedWidth(drag, event.clientX, max),
      })
    },
    [effectiveMaxWidth, activeBreakpoint],
  )

  // useCallback kept: react-hooks/refs escape hatch (see handlePointerDown).
  const finishDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  const handleIframeRef = (handle: IframeFrameSurfaceHandle | null) => {
    setIframeEl(handle?.iframeElement ?? null)
    setOverlayRoot(handle?.contentOverlayRoot ?? null)
  }

  return (
    <div ref={surfaceRef} className={styles.surface} data-testid="canvas-live-surface">
      {page && activeBreakpoint && effectiveWidth !== null ? (
        <div
          className={styles.frame}
          style={{ '--live-width': `${effectiveWidth}px` } as CSSProperties}
        >
          {/*
            Editing chrome, so the player stands it down with everything else.
            The grip is a 2px bar at the screen's edge — while a prototype is
            running it reads as a scrollbar on a phone that should not have one,
            and resizing the frame is not a gesture anyone is reaching for
            mid-flow. It comes back the moment Play is off.
          */}
          {!playMode && (
            <LiveResizeHandle
              side="left"
              onPointerDown={handlePointerDown('left')}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
            />
          )}

          <DeviceMockup kind={deviceKind}>
            <div
              ref={viewportRef}
              data-breakpoint-id={activeBreakpoint.id}
              className={styles.iframeViewport}
            >
            {/*
              In the player, two screen slots so a `push` can move the screen
              it is leaving as well as the one arriving. Outside it, one slot,
              exactly as before — editing never navigates, so it never needs a
              second frame, and mounting one would cost an iframe for nothing.

              DELIBERATELY NOT KEYED on the page id in either case. Keying is
              the obvious way to replay a CSS entrance animation and it
              remounts the `<iframe>` with it; the portal that renders the page
              into the frame's body does not survive that, so every navigation
              landed on an empty device. `playbackMotion` replays the entrance
              against a frame that stays put.
            */}
            {playMode ? (
              <PrototypeScreenStack page={page} transition={screenTransition} renderScreen={renderScreen} />
            ) : (
              <div className={styles.prototypeScreen} data-slot-state="front">
                {renderScreen(page, handleIframeRef)}
              </div>
            )}

              <BreakpointSelectionOverlay
                breakpointId={activeBreakpoint.id}
                viewportRef={viewportRef}
                iframeElement={iframeEl}
                overlayRoot={overlayRoot}
              />

              {/*
                The prototype overlay: a second frame over the first, with a
                scrim, exactly as a popup or a bottom sheet presents over the
                screen it was opened from. The screen underneath stays MOUNTED
                — that is the whole difference between `overlay` and `navigate`,
                and it is why closing one returns instantly with its scroll
                position intact.

                Keyed on the page id so React remounts (and therefore re-runs
                the entrance animation) when one overlay replaces another.
              */}
              <PrototypeOverlay
                page={overlayPage}
                enterTransition={overlayTransition}
                leaveTransition={overlayLeaveTransition}
                renderScreen={renderScreen}
              />
            </div>
          </DeviceMockup>

          {!playMode && (
            <LiveResizeHandle
              side="right"
              onPointerDown={handlePointerDown('right')}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
            />
          )}

          <div className={styles.widthBadge} aria-hidden="true">
            {Math.round(effectiveWidth)}px
          </div>
        </div>
      ) : (
        // Same loading treatment as the design canvas: while the page (or the
        // site's breakpoints) are still hydrating, show the shared frame
        // skeleton in the live frame's own width model instead of a misleading
        // empty state. CanvasTransformLayer does the equivalent per breakpoint.
        <div
          className={styles.frame}
          style={{
            '--live-width': effectiveWidth !== null ? `${effectiveWidth}px` : '100%',
          } as CSSProperties}
          data-testid="canvas-live-loading-frame"
        >
          <div className={styles.iframeViewport}>
            <CanvasFrameSkeleton breakpointId={activeBreakpoint?.id ?? 'live'} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Hides the scrollbars of the frame this renders INSIDE, reading that frame's
 * own document from the context `IframeFrameSurface` publishes. A component
 * rather than a prop because the document is only knowable from within the
 * portal, which is the whole reason the old ref-based wiring reached one frame
 * and missed three.
 */
function FrameScrollbars({ hidden }: { hidden: boolean }) {
  return <DeviceScrollbarInjector targetDocument={use(CanvasDocumentContext)} hidden={hidden} />
}

/**
 * The frame's width before any user resize.
 *
 * `deviceKind` shrinks the space available to the SCREEN, because a mockup's
 * bezel is painted outside the screen box (see `DeviceMockup`) and the surface
 * clips its overflow. Without this the bezel is sliced off on exactly the
 * narrow windows where a tablet mockup comes closest to the container width.
 * The page still gets its full breakpoint width whenever it fits — this only
 * bites when the container was already the binding constraint.
 */
function computeNaturalWidth(
  breakpoint: Breakpoint | null,
  containerWidth: number | null,
  deviceKind: DeviceKind | null,
): number | null {
  if (!breakpoint) return null
  if (containerWidth === null) return breakpoint.width
  const bezel = deviceKind ? DEVICE_BEZEL_PX[deviceKind] * 2 : 0
  return Math.min(breakpoint.width, Math.max(LIVE_MIN_WIDTH, containerWidth - bezel))
}

function computeResizedWidth(drag: ResizeDragState, clientX: number, max: number): number {
  const delta = clientX - drag.startClientX
  const widthDelta = drag.side === 'left' ? -delta * SYMMETRIC_DRAG_FACTOR : delta * SYMMETRIC_DRAG_FACTOR
  const next = drag.startWidth + widthDelta
  return Math.max(LIVE_MIN_WIDTH, Math.min(max, next))
}

interface LiveResizeHandleProps {
  side: 'left' | 'right'
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
}

function LiveResizeHandle({
  side,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: LiveResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize live frame from ${side}`}
      data-side={side}
      data-testid={`canvas-live-resize-${side}`}
      className={styles.resizeHandle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className={styles.resizeGrip} aria-hidden="true" />
    </div>
  )
}
