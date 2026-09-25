/**
 * BreakpointSelectionOverlay — selection chrome for one breakpoint frame:
 * rings, the node badge, the selection toolbar, and the in-place inspector's
 * positioning wrapper.
 *
 * Two coordinate spaces, on purpose (STUDIO-IMPORT-V2-PLAN.md WS-5.1)
 * ─────────────────────────────────────────────────────────────────
 * Rings, the hover ring, the selector-affinity pool, and the node badge are
 * portaled into `overlayRoot` — a zero-size div `CanvasSelectionOverlayInjector`
 * appends to the IFRAME's own `<body>`. They're measured with
 * `measureIframeLocalRect` (no zoom recovery, no iframe-offset addition, no
 * canvas-root origin subtraction) because they live in the SAME document as
 * the element they track. Panning/zooming the canvas moves the iframe element
 * — and this overlay with it — as one composited CSS transform, so this is
 * pixel-correct at every zoom level for free.
 *
 * This used to be the "menu far from the element" defect (`STATE.md`
 * `standing-03`): the OLD design rendered rings in the PARENT document,
 * positioned from `elementRect × zoom + iframeOffset + panOffset`, recomputed
 * every RAF tick — any staleness in any term showed up as displacement,
 * multiplied by zoom. Moving the rings into the iframe eliminates the
 * conversion entirely rather than trying to keep it fresher.
 *
 * The selection toolbar and `InPlaceInspector` genuinely can't make that
 * move — real inputs/buttons inside a transformed iframe are a worse
 * problem — so they stay portaled into the parent canvas root (or
 * `document.body` as a fixed-position fallback when the canvas root ref
 * isn't wired up: tests, a transient mount race). They anchor to a rect
 * computed with the OLD (zoom-converting) `createCanvasOverlayMeasureSession`
 * math, but — unlike the old design — that computation is NOT run every RAF
 * tick. It runs only when `anchorDirtyRef` is set: once on mount, once per
 * selection change, once per pan/zoom COMMIT (the debounced store values,
 * never per pointermove), and once when the inspected node's cheap
 * iframe-local rect changes (content reflow). See `tickOnce`'s own docblock.
 * The resulting rect is also published as the `--selection-anchor-{x,y,w,h}`
 * custom-property channel (`publishSelectionAnchor` — the sanctioned
 * inline-style exception in CLAUDE.md) on both the toolbar and the inspector
 * wrapper. BETWEEN those measurements a pan/zoom moves them arithmetically:
 * each measured pass records a board-space anchor, re-projected on every
 * transform write (`selectionChromeViewportFollow.ts`, PERF-3).
 *
 * When it measures (S4)
 * ──────────────────────
 * There is no standing `requestAnimationFrame` loop. `overlayMeasureScheduler.ts`
 * owns the schedule — a per-frame loop only while something is moving the
 * geometry every frame, and otherwise one pass per event that actually moved
 * something. An idle board with a live selection runs zero rAF callbacks per
 * second, per frame. Read that module before changing when this measures.
 *
 * Everything else
 * ────────────────
 * - One overlay per breakpoint frame. Drop indicators stay inside the breakpoint viewport
 *   (they only appear during a drag, and the transform-scaled coordinate path is established for them).
 * - Resolves the rendered element via `[data-node-id="X"]` — each module
 *   spreads `nodeWrapperProps` onto its own root tag, so the match IS the
 *   rendered `<article>` / `<h1>` / `<div>`. Box-less (`display: contents`)
 *   nodes fall back to the union of their children (`nodeVisualRect`), and
 *   zero-DOM fragment nodes to their rendered descendants (`canvasNodeLookup`).
 * - Clears style positioning when the tracked node disappears or the
 *   selection/hover clears.
 *
 * Contract
 * ────────
 * The ring/badge/indicator overlay is presentational and click-through
 * (`pointer-events: none`). The selected-layer toolbar and the inspector are
 * interactive and clipped by the canvas root.
 */

import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@ui/cn'
import { CanvasFrameAdapterContext, CanvasPageContext, CanvasViewportActionsContext } from './CanvasContexts'
import { SelectionToolbar } from './SelectionToolbar'
import { useCanvasReorderDrag } from './useCanvasReorderDrag'
import { useCanvasTreeLadderOverlay } from './CanvasTreeLadderOverlay'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import { isCanvasGestureActive } from './canvasGesture'
import { useCanvasAnimationScrub } from './animationScrubStore'
import { createOverlayMeasureScheduler, type OverlayMeasureScheduler } from './overlayMeasureScheduler'
import { InPlaceInspectorAnchor } from './InPlaceInspectorAnchor'
import { CanvasDropIndicators } from './CanvasDropIndicators'
import { useCanvasDropSurfaceRegistration } from './useCanvasDropSurfaceRegistration'
import { isBridgeChromeAdapter, useBridgeSelectionChrome } from './useBridgeSelectionChrome'
import { MeasureLayer } from './MeasureLayer'
import {
  createCanvasOverlayMeasureSession,
  measureIframeLocalRect,
  overlayRectIsFinite,
  overlayRectsEqual,
  unionCanvasOverlayRects,
  type CanvasOverlayRect,
} from './canvasOverlayGeometry'
import type { CanvasRectSource } from './canvasDomGeometry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import {
  hideOverlayElement,
  measureSelectorHighlightRects,
  positionInspector,
  positionNodeBadge,
  positionOverlayElement,
  positionResizeFrame,
  positionToolbar,
  publishSelectionAnchor,
  resolveNodeBadgeLabel,
  syncSelectorHighlightRings,
} from './canvasSelectionOverlayPositioning'
import styles from './BreakpointSelectionOverlay.module.css'
import { CanvasSelectionChrome } from './CanvasSelectionChrome'
import { useBreakpointOverlaySelectionState } from './useBreakpointOverlaySelectionState'
import { useSelectionChromeViewportFollow } from './selectionChromeViewportFollow'

/** Stable empty fallback for the frame-scoped selection read below (Guideline #239 — no inline `?? []`). */
const EMPTY_SELECTED_NODE_IDS: readonly string[] = []

interface BreakpointSelectionOverlayProps {
  /**
   * The breakpoint frame this overlay belongs to. Used to scope the hover
   * ring — only the frame that owns the current hover renders one. Selection
   * applies to all frames simultaneously (the user sees the same node
   * highlighted in every breakpoint preview).
   */
  breakpointId: string
  /**
   * Ref to the outer viewport `<div>` (which contains the iframe). Used by
   * the reorder drag for drop-candidate measurement against the wrapping
   * layout box.
   */
  viewportRef: React.RefObject<HTMLElement | null>
  /**
   * The iframe element that hosts this breakpoint's page tree. The overlay
   * queries `iframeElement.contentDocument` for `[data-node-id]` targets,
   * gets their inside-iframe rects, then translates to editor-document
   * coordinates using the iframe's own client rect. `null` until the iframe
   * mounts.
   */
  iframeElement: HTMLIFrameElement | null
  /**
   * The in-iframe selection-overlay root (WS-5.1), created by
   * `CanvasSelectionOverlayInjector` and appended to the iframe's own
   * `<body>`. Rings, the hover ring, the selector-affinity pool, and the
   * node badge portal into THIS instead of the parent canvas root, so they
   * live in the same coordinate space as the element they track — no zoom/
   * pan conversion, no drift. `null` until the injector's effect runs.
   */
  overlayRoot: HTMLElement | null
  /**
   * WS-10 Phase 2 — the owning `BoardFrame.id`, or `null` outside board
   * context (every CMS/VC frame — unchanged, unscoped behaviour: "Selection
   * applies to all frames simultaneously" below still holds there). When set,
   * both the selection ring/toolbar/inspector AND the hover ring are scoped
   * to this frame — a "duplicate as variant" sibling of the same page shares
   * every node id (trap #2) but must not light up from a selection/hover
   * that originated in ITS sibling.
   */
  frameId?: string | null
}

export function BreakpointSelectionOverlay({
  breakpointId,
  viewportRef,
  iframeElement,
  overlayRoot,
  frameId = null,
}: BreakpointSelectionOverlayProps) {
  // Store reads this component needs (selection/hover, scoped the WS-10 way;
  // the selector-affinity highlight; this frame's own page; the VC list the
  // node badge resolves labels against) — pulled into their own hook,
  // `module-size-budgets` (`speed-04`, STATE.md). See that hook's own doc.
  const {
    selectedNodeIds,
    hoveredNodeId,
    hoveredBreakpointOrigin,
    activeBreakpointId,
    highlightedSelector,
    framePage,
    visualComponents,
  } = useBreakpointOverlaySelectionState(breakpointId, frameId)
  // THIS frame's page id, straight from context (not `framePage?.id` — the
  // drag/drop wiring below needs the CONTEXT's id even in the split second
  // `framePage` hasn't resolved yet, same as before this hook existed).
  const framePageId = use(CanvasPageContext)
  // One ref per selected node, keyed by id. Stable across renders while the
  // id stays in the selection — when an id is removed, its ring entry is
  // dropped from the map; when added, a fresh ref is allocated.
  const ringRefs = useRef<Map<string, HTMLDivElement | null> | null>(null)
  if (ringRefs.current === null) ringRefs.current = new Map()
  // One badge per selected node, same keying discipline as ringRefs.
  const badgeRefs = useRef<Map<string, HTMLDivElement | null> | null>(null)
  if (badgeRefs.current === null) badgeRefs.current = new Map()
  const hoverRef = useRef<HTMLDivElement>(null)
  // Filled by `CanvasResizeHandles`; read only by the RAF tick below.
  const resizeFrameRef = useRef<HTMLDivElement | null>(null)
  // Container whose children are the orange selector-affinity rings. Their
  // count is driven by the live DOM (how many elements match the selector), so
  // they're created/positioned imperatively in the RAF tick rather than mapped
  // from React state — there's no node-id list to map over.
  const selectorHighlightRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLDivElement>(null)
  const [portalCanvasRoot, setPortalCanvasRoot] = useState<HTMLElement | null>(null)
  // nodeId → rendered iframe element, reused across RAF ticks so the
  // steady-state tick never pays a per-frame `querySelector` document scan.
  const nodeElementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeElementCacheRef.current === null) nodeElementCacheRef.current = new CanvasNodeElementCache()
  // Gates the EXPENSIVE parent-doc anchor computation (iframe.getBoundingClientRect()
  // + canvasRoot.getBoundingClientRect(), the zoom-multiplied math that caused
  // `standing-03`'s drift). Starts `true` so the toolbar/inspector get positioned
  // on first mount. Set back to `true` by the effect below (selection change /
  // committed pan-zoom) and by tickOnce itself when the inspected node's cheap
  // iframe-local rect changes (content reflow, e.g. editing a prop that resizes
  // the element) — both are real, infrequent events, never a per-pointermove one.
  const anchorDirtyRef = useRef(true)
  // Last iframe-local rect seen for `inspectorNodeId`, to detect (2) above
  // without paying for the expensive conversion on ticks where nothing moved.
  const lastInspectorLocalRectRef = useRef<CanvasOverlayRect | null>(null)
  // S4 — WHEN the tick below runs. Owned by the effect near the bottom of this
  // component; read here so the tick can hand it the elements it just resolved.
  const schedulerRef = useRef<OverlayMeasureScheduler | null>(null)
  const viewportActions = use(CanvasViewportActionsContext)
  // `live-13` — the frame's adapter, provided by `BreakpointFrame` around this
  // overlay. Read from context rather than taken as a prop on purpose: a
  // `BridgeFrameAdapter` holds the iframe's cross-origin `contentWindow`,
  // and React's dev-mode render logging walks a component's changed props —
  // a prop-carried adapter had it reading `location` on that window. For a
  // Tier 2 bridge frame (no `overlayRoot`, no reachable document) the rings,
  // resize handles and the toolbar/inspector anchor are driven through it
  // instead of measured here — see `useBridgeSelectionChrome`; the tick
  // below must neither measure that chrome (it cannot) nor hide what the
  // bridge hook placed.
  const adapter = use(CanvasFrameAdapterContext)
  const bridgeChrome = isBridgeChromeAdapter(adapter)
  // PERF-3 — the toolbar/inspector follow every pan/zoom transform write from
  // the anchor each measured pass records, instead of freezing until the
  // debounced commit. See `selectionChromeViewportFollow.ts`.
  const recordChromeAnchor = useSelectionChromeViewportFollow({
    transformRef: viewportActions?.transformRef,
    toolbarRef,
    inspectorRef,
  })

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = viewportActions?.canvasRootRef.current ?? null
      setPortalCanvasRoot((current) => (current === root ? current : root))
    })
    return () => cancelAnimationFrame(frame)
  }, [viewportActions])

  // Selection toolbar (drag / duplicate / delete) is purely structural —
  // hidden for callers without `site.structure.edit`. Content-only Clients
  // still get the selection ring (they click to select for content edit),
  // but no action chrome.
  //
  // Pure Viewers (no edit caps at all) see neither rings nor toolbar — the
  // canvas is a read-only inspection surface for them; selection ribbons
  // would just be visual clutter with no follow-on action available.
  const permissions = useEditorPermissions()
  const showRings =
    permissions.canEditStructure || permissions.canEditContent || permissions.canEditStyle
  const showSelectorHighlight = showRings && Boolean(highlightedSelector)
  // The toolbar additionally needs a selection; body press-and-drag does not.
  const canEditStructureHere = permissions.canEditStructure && activeBreakpointId === breakpointId
  const showToolbar = canEditStructureHere && selectedNodeIds.length > 0

  // In-place mini-inspector (Phase 2): single-select only. Unlike
  // `showToolbar` above, this deliberately does NOT gate on
  // `activeBreakpointId === breakpointId` — every studio board frame shares
  // the same synthetic 'studio' breakpoint id (see BoardFramesLayer's KNOWN
  // LIMITATION), so that check can't distinguish frames. Instead, whichever
  // frame's iframe actually contains the selected node's element (checked via
  // the measured rect in the RAF tick below) is the one that renders it — the
  // same per-frame resolution the selection ring already relies on.
  const showInspector = selectedNodeIds.length === 1
  const inspectorNodeId = showInspector ? selectedNodeIds[0] : null

  // Pan/zoom "commit" signal for the anchor recompute below — `zoom`/`panX`/
  // `panY` in the store are the DEBOUNCED values `useCanvas.ts` writes ~100ms
  // after a gesture ends (see its own docblock), never per pointermove. This
  // is exactly the "once per pan/zoom commit" trigger WS-5.1 asks for — no
  // separate throttling needed here.
  const committedTransform = useEditorStore(useShallow((s) => [s.zoom, s.panX, s.panY] as const))
  const selectedNodeIdsSignature = selectedNodeIds.join(',')
  useEffect(() => {
    anchorDirtyRef.current = true
    // S4 — the tick is no longer running every frame, so marking the anchor
    // dirty is only half the job: something has to ask for the pass that acts
    // on it. These four inputs ARE the "selection changed / pan-zoom
    // committed / tree mutated" triggers the old permanent loop absorbed.
    schedulerRef.current?.schedule()
  }, [selectedNodeIdsSignature, showToolbar, inspectorNodeId, committedTransform])

  // Portal target: the canvas root (so chrome sits inside the canvas's own
  // stacking + clipping context) — or, under a viewport context, NOTHING until
  // it resolves. Parking chrome in `document.body` first and relocating it
  // REMOUNTS the portal subtree, discarding its state. See canvas-internals.md.
  const portalTarget = portalCanvasRoot ?? (viewportActions ? null : document.body)
  const chromeTarget = overlayRoot ?? portalTarget
  const toolbarMode = portalCanvasRoot ? 'scoped' : 'fixed'
  const treeLadder = useCanvasTreeLadderOverlay({
    breakpointId,
    iframeElement,
    canvasRoot: portalCanvasRoot,
    portalTarget,
    portalMode: toolbarMode,
    show: showRings,
    hoveredNodeId,
    hoveredBreakpointOrigin,
    // K5 — the ladder stands down while Alt-hover MEASUREMENT owns the
    // gesture. The rule lives in `measurementWinsOverTreeLadder`; the ladder
    // applies it itself so the two can never drift apart.
    selectedNodeIds,
  })
  // Hover only renders when the hovered node isn't already part of the
  // selection — otherwise the two rings would stack and the hover ring
  // would mask the selection ring. In Alt/Option inspect mode, the ladder
  // highlight becomes the hover ring target so keyboard navigation is visible.
  const hoverRingNodeId = treeLadder.hoverNodeId ?? hoveredNodeId
  const showHover = Boolean(hoverRingNodeId) && !selectedNodeIds.includes(hoverRingNodeId ?? '')
  // A hover TARGET change is a measure trigger — see `overlayMeasureScheduler`.
  const hoverTargetId = showHover ? hoverRingNodeId : null
  useEffect(() => schedulerRef.current?.schedule(), [hoverTargetId])
  const reorderDrag = useCanvasReorderDrag({
    viewportRef,
    iframeElement,
    overlayRoot,
    selectedNodeIds,
    frameId,
    // D2 G3 — which FILE a drag out of this frame is moving markup from.
    pageId: framePageId,
    enabled: showToolbar,
    bodyDragEnabled: canEditStructureHere,
    panBy: viewportActions?.panBy,
    canvasRootRef: viewportActions?.canvasRootRef,
    // D1's LIVE transform — see `canvasDragSession.ts` for why not the store's.
    transformRef: viewportActions?.transformRef,
  })

  // D2 G3 — publish this frame as a place a drag from ANOTHER frame can land.
  // P5-B: on the permission alone, not on being the active frame — an OS file
  // drop has no pointerdown, so its frame is usually inactive, and it
  // activates its own page when it lands (`imageDropActions.ts`).
  useCanvasDropSurfaceRegistration({
    enabled: permissions.canEditStructure,
    frameId,
    pageId: framePageId,
    viewportRef,
    iframeElement,
    dropLayerRef: reorderDrag.dropLayerRef,
  })

  // One measurement pass. Reads the freshest selection / hover / toolbar inputs
  // from the latest render closure via useEffectEvent, so the scheduler effect
  // below only re-arms when measurement should start or stop — not on every
  // change to which specific nodes are tracked. WHEN it runs is
  // `overlayMeasureScheduler.ts`'s job (S4); WHAT it costs is this:
  //
  //  1. Iframe-local read + write (rings, hover ring, selector-affinity pool,
  //     node badge) — every pass. `measureIframeLocalRect` reads the target's
  //     rect directly (no zoom recovery, no iframe-offset addition, no
  //     canvas-root origin subtraction — see its own docblock), because these
  //     elements are portaled into `overlayRoot`, which lives in the SAME
  //     iframe document as the elements they track. Panning/zooming moves the
  //     whole iframe (and this overlay with it) as one composited transform,
  //     so this is correct at every zoom level with zero conversion.
  //  2. Parent-doc anchor (toolbar, InPlaceInspector) — ONLY when
  //     `anchorDirtyRef.current` is true: once on mount, once per selection
  //     change / pan-zoom commit / parent-window resize, and once when the
  //     inspected node's cheap iframe-local rect actually changed since the
  //     last pass (content reflow — e.g. editing a prop through the inspector
  //     that resizes the element). This is the expensive path
  //     (`iframe.getBoundingClientRect()` + `canvasRoot.getBoundingClientRect()`,
  //     the same zoom-multiplied math that caused `standing-03`'s drift) —
  //     paying for it only on these real, infrequent events (never per
  //     pointermove) is the whole point of WS-5.1's bounded-cost requirement.
  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null) => {
    const canvasRoot = portalCanvasRoot
    const iframeDoc = resolvePortalDocument(iframe) // portal-mode only; see its own doc
    const elementCache = nodeElementCacheRef.current!

    if (!iframe || !iframeDoc) {
      // A bridge frame never has a reachable document: its rings are the
      // runtime's, and `useBridgeSelectionChrome` owns the toolbar/inspector
      // anchor — hiding them here would undo its placement every tick.
      if (bridgeChrome) return
      // Nothing measurable (iframe not mounted yet / reloading). Rings/hover/
      // selector-highlight/badge now live INSIDE the iframe document, so when
      // it's gone there is nothing there to hide — only the parent-doc
      // toolbar/inspector need an explicit hide.
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordChromeAnchor(null)
      return
    }

    // `overlayRoot` is `null` for a LIVE frame — `IframeFrameSurface` never
    // mounts `CanvasSelectionOverlayInjector` there (WS-5.1 is design-mode
    // only). A live frame isn't inside `CanvasTransformLayer`, so it was
    // never subject to `standing-03`'s zoom-multiplied drift in the first
    // place — falling back to the OLD zoom-converting measurement (session,
    // created lazily, at most once per tick) is exactly correct there, not a
    // regression. It also covers the brief design-mode startup window before
    // the injector's own effect has created the root.
    let fallbackSession: ReturnType<typeof createCanvasOverlayMeasureSession> | null = null
    const measureRing = (target: CanvasRectSource | null): CanvasOverlayRect | null => {
      if (overlayRoot) return measureIframeLocalRect(target)
      fallbackSession ??= createCanvasOverlayMeasureSession(iframe, canvasRoot)
      return fallbackSession.measure(target)
    }

    // ── Ring/badge READ phase (cheap in the common design-mode case) ─────
    const trackedIds = new Set<string>()
    // S4 — the elements this pass resolved, handed to the scheduler so their
    // OWN size changes schedule the next pass. A late-loading image inside a
    // fixed-height container resizes the tracked element without mutating the
    // DOM and without resizing the frame body, so neither of the frame-level
    // observers would see it.
    const trackedElements: Array<CanvasRectSource | null> = []
    const ringPlacements: Array<{ id: string; ring: HTMLDivElement | null; rect: CanvasOverlayRect | null }> = []
    for (const id of selectedNodeIds) {
      trackedIds.add(id)
      const element = elementCache.resolve(iframeDoc, id, framePage)
      trackedElements.push(element)
      ringPlacements.push({ id, ring: ringRefs.current?.get(id) ?? null, rect: measureRing(element) })
    }

    const hoverId = showHover ? hoverRingNodeId : null
    let hoverRect: CanvasOverlayRect | null = null
    if (hoverId) {
      trackedIds.add(hoverId)
      const hoverElement = elementCache.resolve(iframeDoc, hoverId, framePage)
      trackedElements.push(hoverElement)
      hoverRect = measureRing(hoverElement)
    }
    elementCache.retainOnly(trackedIds)
    schedulerRef.current?.observe(trackedElements)

    const selectorRects = measureSelectorHighlightRects(
      showSelectorHighlight ? highlightedSelector : null,
      iframeDoc,
      measureRing,
    )

    // ── Ring/badge WRITE phase ────────────────────────────────────────────
    for (const { ring, rect } of ringPlacements) positionOverlayElement(ring, rect)
    // Resize handles (and, mid-drag, their W×H badge) ride the SAME measured
    // rect as the ring, so they cannot drift off the box they belong to.
    // WHETHER they exist is `canOfferResize`'s call, in `CanvasResizeHandles`
    // — no second gate here: re-deriving it is how the two would disagree.
    const soleRing = ringPlacements.length === 1 ? ringPlacements[0] : undefined
    positionResizeFrame(resizeFrameRef.current, soleRing ? soleRing.rect : null)
    positionOverlayElement(hoverRef.current, hoverRect)
    syncSelectorHighlightRings(
      selectorHighlightRef.current,
      selectorRects,
      overlayRoot ? null : { className: cn(styles.ring, styles.selectorHighlight), mode: toolbarMode },
    )
    // Badge is design-mode only (see `canvasChrome`'s render gate) — no live-
    // mode fallback, so no work when `overlayRoot` isn't the active mode.
    if (overlayRoot && showRings) {
      for (const { id, rect } of ringPlacements) {
        const badge = badgeRefs.current?.get(id) ?? null
        positionNodeBadge(badge, rect, resolveNodeBadgeLabel(framePage, id, visualComponents))
      }
    }

    // A pointer gesture that changes layout every frame (an element resize) is
    // the one case this tick's cost model does not cover: the rect below would
    // differ on EVERY frame, marking the anchor dirty and running the
    // "expensive, rare" parent-doc measure session per pointermove. The rings
    // above have already been positioned, so they keep tracking the element;
    // the toolbar and inspector simply hold still until the drag ends, and
    // `canvasGesture`'s settle pass recomputes them once. See `canvasGesture.ts`.
    if (isCanvasGestureActive()) return

    // Content-reflow detection for the inspected node (see tick docblock,
    // point 2): compare THIS tick's already-measured cheap local rect against
    // the last one seen. A real change (not a reference change — a value
    // change) marks the anchor dirty for the branch below, in the SAME tick.
    if (inspectorNodeId) {
      const localRect = ringPlacements.find((p) => p.id === inspectorNodeId)?.rect ?? null
      if (!overlayRectsEqual(lastInspectorLocalRectRef.current, localRect)) {
        anchorDirtyRef.current = true
      }
      lastInspectorLocalRectRef.current = localRect
    }

    // ── Parent-doc anchor (expensive, rare) ───────────────────────────────
    const needsAnchor = showToolbar || Boolean(inspectorNodeId)
    if (!needsAnchor) {
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordChromeAnchor(null)
      return
    }
    if (!anchorDirtyRef.current) return

    // `speed-04` (STATE.md) — this frame's own ring placements (just
    // measured above, cheaply) already say whether it renders ANY of the
    // selected nodes at all: `rect` is non-null only when
    // `elementCache.resolve` found the element inside THIS iframe's
    // document. When none did, the session below would only ever measure
    // `null` for every id — empty union, no inspector rect, both hidden —
    // exactly what the early return two lines down already produces for
    // free. Skipping the session is behavior-preserving (same output, two
    // fewer forced `getBoundingClientRect()` reads), and it is the case
    // that matters: a board frame's own selection is already scoped away
    // to `EMPTY_SELECTED_NODE_IDS` for every OTHER frame in the pool
    // (`selectedNodeFrameId`, above), but the CMS/Visual-Component canvas
    // mirrors one selection across every real breakpoint frame on purpose
    // — only the frame that actually renders the node should pay for the
    // anchor measure.
    const ownsAnySelectedNode = ringPlacements.some((placement) => placement.rect !== null)
    if (!ownsAnySelectedNode) {
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordChromeAnchor(null)
      anchorDirtyRef.current = false
      return
    }

    // Reuse the session already created for the fallback ring path (live
    // mode, or the brief design-mode startup window) instead of a second one.
    const session = fallbackSession ?? createCanvasOverlayMeasureSession(iframe, canvasRoot)
    let toolbarUnion: CanvasOverlayRect | null = null
    // The inspector's rect comes from this SAME session pass — `null` here
    // means this frame's iframe doesn't contain the selected node's element,
    // which is exactly how the inspector ends up rendered in only the one
    // studio board frame that owns it.
    let inspectorRect: CanvasOverlayRect | null = null
    for (const id of selectedNodeIds) {
      const rect = session.measure(elementCache.resolve(iframeDoc, id, framePage))
      if (showToolbar && rect) toolbarUnion = unionCanvasOverlayRects(toolbarUnion, rect)
      if (inspectorNodeId === id) inspectorRect = rect
    }

    positionToolbar(toolbarRef.current, showToolbar ? toolbarUnion : null, session.canvasRect)
    publishSelectionAnchor(toolbarRef.current, showToolbar ? toolbarUnion : null)
    positionInspector(inspectorRef.current, inspectorNodeId ? inspectorRect : null, session.canvasRect)
    publishSelectionAnchor(inspectorRef.current, inspectorNodeId ? inspectorRect : null)
    recordChromeAnchor({
      toolbar: showToolbar ? toolbarUnion : null,
      inspector: inspectorNodeId ? inspectorRect : null,
      canvasRect: session.canvasRect,
    })
    // Only commit "clean" when both rects came out finite (or legitimately
    // null — the frame doesn't own the node). A layout read taken mid-reflow
    // can occasionally come back non-finite (e.g. an iframe measured the
    // instant it's mid-resize); committing that as "done" would freeze the
    // toolbar/inspector in a broken position until the NEXT selection change
    // or pan/zoom commit, since this branch — unlike the old per-tick design
    // — doesn't get a chance to self-correct next frame by default. Leaving
    // `anchorDirtyRef` true instead makes this tick retry on the very next
    // one, restoring that same self-correction without paying for it every
    // tick in the common case.
    if (overlayRectIsFinite(toolbarUnion) && overlayRectIsFinite(inspectorRect)) {
      anchorDirtyRef.current = false
    }
  })

  // Measurement exists to re-position overlay chrome as the tracked element
  // moves. When there is nothing to track — no selection rings, no hover ring,
  // no selector-affinity rings, no toolbar — there is no work to do, so nothing
  // is armed at all: no scheduler, no observers, no listeners. N frames idle
  // with no selection cost exactly nothing.
  const hasOverlayWork =
    showToolbar ||
    showSelectorHighlight ||
    (showRings && (selectedNodeIds.length > 0 || showHover))

  // S4 — the two continuous gestures this component can see from RENDER state.
  // A reorder drag moves the tracked element every frame; an animation replay
  // (`animationScrubStore`'s `'playing'` phase, board-wide) does the same for a
  // couple of hundred milliseconds. Everything else that needs a per-frame loop
  // (element resize, pan/zoom, a bridge frame's HMR swap) is an imperative
  // signal the scheduler subscribes to itself — see its docblock.
  const animationScrub = useCanvasAnimationScrub()
  const continuousGesture = reorderDrag.dragging || animationScrub.phase === 'playing'

  useEffect(() => {
    if (!hasOverlayWork) return

    const scheduler = createOverlayMeasureScheduler({
      iframeElement,
      // In-frame rings (portal overlay root, or a bridge runtime's own) move
      // with the frame's transform — a pan needs no per-frame pass (PERF-3).
      ringsFollowViewport: Boolean(overlayRoot) || bridgeChrome,
      measure: () => tickOnce(iframeElement),
      // A parent-window resize moves the canvas root's own rect, which the
      // in-iframe rect comparison inside the tick structurally cannot see.
      invalidateAnchor: () => {
        anchorDirtyRef.current = true
      },
      continuous: continuousGesture,
    })
    schedulerRef.current = scheduler

    return () => {
      if (schedulerRef.current === scheduler) schedulerRef.current = null
      scheduler.dispose()
    }
  }, [hasOverlayWork, iframeElement, overlayRoot, bridgeChrome, continuousGesture])

  const toolbar = showToolbar ? (
    <SelectionToolbar
      toolbarRef={toolbarRef}
      mode={toolbarMode}
      onDragPointerDown={reorderDrag.handlePointerDown}
    />
  ) : null

  // Rings and the selector-affinity pool render INSIDE the iframe document
  // (WS-5.1) whenever `overlayRoot` is available — portaled there instead of
  // the parent canvas root, appearance coming from
  // `CanvasSelectionOverlayInjector`'s stylesheet via the stable
  // `data-canvas-*` selectors below (CSS Module classes from THIS file don't
  // exist inside the iframe — see `EditorChromeInjector`'s docblock).
  //
  // `overlayRoot` is `null` for a LIVE frame (design-mode-only injector,
  // never mounted there) and for the brief design-mode startup window before
  // the injector's own effect has run. Both fall back to the ORIGINAL
  // parent-doc rendering — CSS Module classes + the scoped/fixed
  // `data-canvas-ring-mode` attribute (same `toolbarMode` the toolbar already
  // uses) — which is exactly correct for live mode: a live frame isn't
  // inside `CanvasTransformLayer`, so it was never subject to the
  // zoom-multiplied drift this work order fixes.
  const usingIframeOverlay = Boolean(overlayRoot)
  // A SINGLE selection only: the drag writes an inline style to one element,
  // so three selected elements would mean three edits behind one set of
  // handles — a different feature, not a loop over this one. In-iframe only:
  // the parent-document fallback positions from zoom-converted math
  // (`standing-03`), and handles are far less forgiving of drift than a ring.
  const resizeNodeId = usingIframeOverlay && showRings && selectedNodeIds.length === 1
    ? (selectedNodeIds[0] ?? null)
    : null
  // `live-13` — the same rings, hover, handles and anchor for a bridge frame, through its adapter.
  useBridgeSelectionChrome(bridgeChrome ? adapter : null, {
    iframeElement, canvasRoot: portalCanvasRoot, selectedNodeIds: showRings ? selectedNodeIds : EMPTY_SELECTED_NODE_IDS,
    hoverNodeId: showHover ? hoverRingNodeId : null, showToolbar, inspectorNodeId, toolbarRef, inspectorRef, committedTransform,
    recordAnchor: recordChromeAnchor,
  })
  // This component owns `resizeFrameRef`, so this component writes it —
  // the chrome below is handed a setter, never the ref.
  const setResizeFrameElement = (element: HTMLDivElement | null) => {
    resizeFrameRef.current = element
  }

  // PERF-2 — the hover ring is hidden by a style write, never unmounted, so a
  // hover crossing is an attribute change, not a `childList` one under the
  // frame's observed `<body>`. Layout effect: hidden before the first paint of
  // a freshly mounted chrome too.
  useLayoutEffect(() => {
    if (!showHover) hideOverlayElement(hoverRef.current)
  }, [showHover, chromeTarget])

  // The rings/badges/handles themselves — see `CanvasSelectionChrome`. It is
  // elements only; this component keeps every measurement and every ref.
  // Mounted whenever rings are shown at all (PERF-2): starting or ending a
  // hover must not mount or unmount anything.
  const canvasChrome = showRings ? (
    <CanvasSelectionChrome
      selectedNodeIds={selectedNodeIds}
      hoverRingNodeId={showHover ? hoverRingNodeId : null}
      showSelectorHighlight={showSelectorHighlight}
      usingIframeOverlay={usingIframeOverlay}
      toolbarMode={toolbarMode}
      resizeNodeId={resizeNodeId}
      overlayRoot={overlayRoot}
      selectorHighlightRef={selectorHighlightRef}
      hoverRef={hoverRef}
      ringRefs={ringRefs}
      badgeRefs={badgeRefs}
      onResizeFrameReady={setResizeFrameElement}
    />
  ) : null

  // Studio-only mini-inspector (Phase 2), anchored just below the selection
  // ring by the measure pass and the pan/zoom follower — see its own doc.
  const inspector = inspectorNodeId ? (
    <InPlaceInspectorAnchor anchorRef={inspectorRef} nodeId={inspectorNodeId} mode={toolbarMode} breakpointId={breakpointId} />
  ) : null

  return (
    <>
      {/* React renders an EMPTY layer inside the breakpoint viewport; the drag
          session paints the drop line, the refusal chip and the ghost into it.
          See `CanvasDropIndicators` / `canvasDragPainter`. */}
      <CanvasDropIndicators layerRef={reorderDrag.dropLayerRef} />
      {/* K5 — Alt-hover measurements. Owns its own Alt/visibility state and
          renders nothing until the gesture is live; see `MeasureLayer`. */}
      <MeasureLayer iframeElement={iframeElement} overlayRoot={overlayRoot} portalTarget={portalTarget} portalMode={toolbarMode} canvasRoot={portalCanvasRoot} selectedNodeIds={selectedNodeIds} hoveredNodeId={hoveredNodeId} enabled={showRings} />
      {canvasChrome && chromeTarget && createPortal(canvasChrome, chromeTarget)}
      {toolbar && portalTarget && createPortal(toolbar, portalTarget)}
      {inspector && portalTarget && createPortal(inspector, portalTarget)}
      {treeLadder.portal}
    </>
  )
}
