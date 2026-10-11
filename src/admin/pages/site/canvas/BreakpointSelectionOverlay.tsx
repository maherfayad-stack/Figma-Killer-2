/**
 * BreakpointSelectionOverlay — selection chrome for one breakpoint frame:
 * rings, the node badge, resize handles, the selection toolbar, and the
 * in-place inspector's positioning wrapper.
 *
 * Two homes, on purpose
 * ──────────────────────
 * Rings, the hover ring, the selector-affinity pool, the node badge and the
 * resize / spacing handles are rendered in the PARENT document, in a zero-size
 * chrome root beside the frame's iframe (`FrameChrome.module.css`), in the
 * frame's own viewport px. The frame sits inside the board's transform layer,
 * so pan and zoom move the chrome with it as one composited transform: nothing
 * to convert, nothing to go stale. Nothing is ever appended to the frame's
 * document (SB-4; it used to be, and every ring write was a mutation the frame's
 * own observers had to learn to ignore).
 *
 * WHERE a node's box is comes from the frame's rect index
 * (`frameGeometry/`, `frameChromeRects.ts`) — one batched read per layout
 * change, the same for a same-origin frame and a cross-origin bridge frame —
 * not from looking the element up and measuring it.
 *
 * The selection toolbar and `InPlaceInspector` genuinely cannot live beside the
 * iframe — they are real inputs and buttons, at screen size, clipped by the
 * canvas root — so they stay portaled into the canvas root (or `document.body`
 * as a fixed-position fallback when no viewport context exists: tests, CMS/VC).
 * They anchor to a rect projected from the same index read through the
 * zoom-converting `createCanvasOverlayMeasureSession`, which is NOT run every
 * frame: only when `anchorDirtyRef` is set — once on mount, once per selection
 * change, once per pan/zoom COMMIT, and once when the inspected node's rect
 * changes. The result is also published as the `--selection-anchor-{x,y,w,h}`
 * custom-property channel (`publishSelectionAnchor`). BETWEEN those measurements
 * a pan/zoom moves them arithmetically (`selectionChromeViewportFollow.ts`).
 *
 * When it places (SB-4)
 * ──────────────────────
 * There is no standing `requestAnimationFrame` loop and no observer of this
 * component's own. `frameChromeScheduler.ts` owns the schedule: one pass per
 * event that moved something (the index's `geometry:dirty`, a selection or hover
 * change, a gesture ending), a per-frame loop only while a gesture moves boxes
 * with no event. A hover is placed synchronously, in the event's own task, from
 * the index (`placeHoverNow`) — it does not wait for React.
 *
 * Everything else
 * ────────────────
 * - One overlay per breakpoint frame. Drop indicators stay inside the breakpoint
 *   viewport (they only appear during a drag).
 * - Box-less (`display: contents`) nodes carry the union of their children in
 *   the index, and zero-DOM fragment nodes fall back to their children through
 *   the page tree (`frameChromeRects.ts`).
 * - Hides its elements when the tracked node disappears or the selection/hover
 *   clears.
 *
 * Contract
 * ────────
 * The ring/badge/indicator overlay is presentational and click-through
 * (`pointer-events: none`); the handles opt back in. The selected-layer toolbar
 * and the inspector are interactive and clipped by the canvas root.
 */

import { use, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useShallow } from 'zustand/react/shallow'
import { CanvasFrameAdapterContext, CanvasPageContext, CanvasViewportActionsContext } from './CanvasContexts'
import { SelectionToolbar } from './SelectionToolbar'
import { useCanvasReorderDrag } from './useCanvasReorderDrag'
import { useCanvasTreeLadderOverlay } from './CanvasTreeLadderOverlay'
import { isCanvasGestureActive } from './canvasGesture'
import { getCanvasHover, subscribeCanvasHover } from './canvasHover'
import { useCanvasAnimationScrub } from './animationScrubStore'
import { createFrameChromeScheduler, type FrameChromeScheduler } from './frameChromeScheduler'
import { chromeRectOf } from './frameChromeRects'
import { InPlaceInspectorAnchor } from './InPlaceInspectorAnchor'
import { useInspectorClosedAfterDrag } from './useInspectorClosedAfterDrag'
import { CanvasDropIndicators } from './CanvasDropIndicators'
import { useCanvasDropSurfaceRegistration } from './useCanvasDropSurfaceRegistration'
import { isBridgeChromeAdapter, useBridgeResizeTarget } from './useBridgeResizeTarget'
import { MeasureLayer } from './MeasureLayer'
import {
  createCanvasOverlayMeasureSession,
  measureIframeLocalRect,
  overlayRectIsFinite,
  unionCanvasOverlayRects,
  type CanvasOverlayRect,
} from './canvasOverlayGeometry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import { getFrameLocalGeometry, readFrameLocalGeometryNow } from './frameGeometry/frameGeometryRegistry'
import type { FrameGeometryIndex } from './frameGeometry/frameGeometryIndex'
import {
  hideOverlayElement,
  measureSelectorHighlightRects,
  positionInspector,
  positionNodeBadge,
  positionOverlayElement,
  positionResizeFrame,
  resizeFrameRect,
  positionToolbar,
  publishSelectionAnchor,
  resolveNodeBadgeLabel,
  syncSelectorHighlightRings,
} from './canvasSelectionOverlayPositioning'
import chromeStyles from './FrameChrome.module.css'
import { CanvasSelectionChrome } from './CanvasSelectionChrome'
import { hoverNodeForFrame, useBreakpointOverlaySelectionState } from './useBreakpointOverlaySelectionState'
import { useSelectionChromeViewportFollow } from './selectionChromeViewportFollow'
import { registerFrameChrome } from './frameChromeRegistry'

/** Stable empty fallback for the frame-scoped selection read below (Guideline #239 — no inline `?? []`). */
const EMPTY_SELECTED_NODE_IDS: readonly string[] = []

/** Marks the hover ring with the node it names — written with the ring's placement, never by React (see `CanvasSelectionChrome`). */
const OVERLAY_NODE_ID_ATTR = 'data-canvas-overlay-node-id'

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
   * The iframe element that hosts this breakpoint's page tree: the key its
   * rect index and its drop surface are registered under, and what the
   * toolbar / inspector anchor is projected from. `null` until the iframe
   * mounts.
   */
  iframeElement: HTMLIFrameElement | null
  /**
   * A DESIGN frame (the board and the CMS canvas) gets the full editing chrome:
   * resize and spacing handles, the node badge, the body drag and the in-frame
   * marquee. The live surface passes `false` and gets rings only — a live page
   * behaves like the published one.
   */
  designMode?: boolean
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
  designMode = true,
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
  // Filled by `CanvasResizeHandles`; read only by the placement pass below.
  const resizeFrameRef = useRef<HTMLDivElement | null>(null)
  // Container whose children are the orange selector-affinity rings. Their
  // count is driven by the live DOM (how many elements match the selector), so
  // they're created/positioned imperatively in the placement pass rather than
  // mapped from React state — there's no node-id list to map over.
  const selectorHighlightRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLDivElement>(null)
  const [portalCanvasRoot, setPortalCanvasRoot] = useState<HTMLElement | null>(null)
  // The zero-size chrome root beside the iframe. State, not a ref, because the
  // measure layer and the marquee need it as an effect input.
  const [chromeRoot, setChromeRoot] = useState<HTMLDivElement | null>(null)
  // Whether the frame's index lists a box for EVERY selected node. The resize handles read the element in
  // render (`canOfferResize` needs its display and tag), so they must not mount before the element exists: a
  // selection made before the frame's tree has committed would otherwise find no element once and never ask again.
  const [selectionBoxed, setSelectionBoxed] = useState(false)
  // Gates the EXPENSIVE parent-doc anchor computation (iframe.getBoundingClientRect()
  // + canvasRoot.getBoundingClientRect(), the zoom-multiplied math that caused
  // `standing-03`'s drift). Starts `true` so the toolbar/inspector get positioned
  // on first mount. Set back to `true` by the effect below (selection change /
  // committed pan-zoom) and by the pass itself when the inspected node's rect
  // changes (content reflow, e.g. editing a prop that resizes the element) —
  // both are real, infrequent events, never a per-pointermove one.
  const anchorDirtyRef = useRef(true)
  // The selection's frame-local rects as of the last pass, as a string, to detect
  // (2) above without paying for the expensive conversion on passes where
  // nothing moved.
  const lastPlacedRectsKeyRef = useRef('')
  // WHEN the pass below runs. Owned by the effect near the bottom of this
  // component; read here so the selection / hover effects can ask for a pass.
  const schedulerRef = useRef<FrameChromeScheduler | null>(null)
  // Bumped by every placement pass; an answer that arrives after a newer pass started is dropped.
  const passGenerationRef = useRef(0)
  const viewportActions = use(CanvasViewportActionsContext)
  // `live-13` — the frame's adapter, provided by `BreakpointFrame` around this
  // overlay. Read from context rather than taken as a prop on purpose: a
  // `BridgeFrameAdapter` holds the iframe's cross-origin `contentWindow`,
  // and React's dev-mode render logging walks a component's changed props —
  // a prop-carried adapter had it reading `location` on that window.
  const adapter = use(CanvasFrameAdapterContext)
  const bridgeChrome = isBridgeChromeAdapter(adapter)
  // The frame's same-origin document, for the handles' element reads, the
  // selector-affinity query and the body-drag / marquee listeners; `null` for a
  // bridge frame. Re-resolved whenever the adapter (one per document) changes.
  const frameDocument = resolvePortalDocument(iframeElement)
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
  // frame's index actually contains the selected node (a non-null rect in the
  // placement pass below) is the one that renders it — the same per-frame
  // resolution the selection ring already relies on.
  const showInspector = selectedNodeIds.length === 1
  const inspectorNodeId = showInspector ? selectedNodeIds[0] : null

  // Pan/zoom "commit" signal for the anchor recompute below — `zoom`/`panX`/
  // `panY` in the store are the DEBOUNCED values `useCanvas.ts` writes ~100ms
  // after a gesture ends (see its own docblock), never per pointermove.
  const committedTransform = useEditorStore(useShallow((s) => [s.zoom, s.panX, s.panY] as const))
  const selectedNodeIdsSignature = selectedNodeIds.join(',')

  // Portal target: the canvas root (so chrome sits inside the canvas's own
  // stacking + clipping context) — or, under a viewport context, NOTHING until
  // it resolves. Parking chrome in `document.body` first and relocating it
  // REMOUNTS the portal subtree, discarding its state. See canvas-internals.md.
  const portalTarget = portalCanvasRoot ?? (viewportActions ? null : document.body)
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
  // selection — otherwise the two rings would stack and the hover ring would
  // mask the selection ring. In Alt/Option inspect mode, the ladder highlight
  // becomes the hover ring target so keyboard navigation is visible.
  const hoverRingNodeId = treeLadder.hoverNodeId ?? hoveredNodeId
  const showHover = Boolean(hoverRingNodeId) && !selectedNodeIds.includes(hoverRingNodeId ?? '')
  // A hover TARGET change is a placement trigger — see `frameChromeScheduler`.
  const hoverTargetId = showHover ? hoverRingNodeId : null

  // Placement exists to keep chrome on the element as it moves. When there is
  // nothing to track — no selection rings, no hover ring, no selector-affinity
  // rings, no toolbar — there is no work to do, so nothing is armed at all: no
  // scheduler, no subscriptions, no listeners. N frames idle with no selection
  // cost exactly nothing.
  const hasOverlayWork =
    showToolbar ||
    showSelectorHighlight ||
    (showRings && (selectedNodeIds.length > 0 || showHover))

  const reorderDrag = useCanvasReorderDrag({
    viewportRef,
    iframeElement,
    frameDocument: designMode ? frameDocument : null,
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
    chromeRoot,
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

  // The hover ring, placed from the index in the event's own task: a fresh
  // index answers as is, a stale same-origin one is re-read synchronously (one
  // batched read, about a millisecond on a 140-node frame), so a ring is never
  // drawn from a picture the frame has left.
  const placeHoverNow = useEffectEvent(() => {
    const ring = hoverRef.current
    if (!ring || !iframeElement || !showRings) return
    const hover = hoverNodeForFrame(getCanvasHover(), {
      breakpointId,
      frameId,
      framePageId,
      nodeIdToPageIds: useEditorStore.getState()._nodeIdToPageIds,
    })
    const target = treeLadder.hoverNodeId ?? hover
    if (!target || selectedNodeIds.includes(target)) {
      hideOverlayElement(ring)
      ring.removeAttribute(OVERLAY_NODE_ID_ATTR)
      return
    }
    const index = readFrameLocalGeometryNow(iframeElement)
    if (!index) {
      // A bridge frame whose index is stale: the scheduled pass lands the ring when the frame answers.
      schedulerRef.current?.schedule()
      return
    }
    ring.setAttribute(OVERLAY_NODE_ID_ATTR, target)
    positionOverlayElement(ring, chromeRectOf(index, framePage, target))
  })
  useEffect(() => subscribeCanvasHover(() => placeHoverNow()), [])

  // One placement pass. Reads the freshest selection / hover / toolbar inputs
  // from the latest render closure via useEffectEvent, so the scheduler effect
  // below only re-arms when placement should start or stop — not on every
  // change to which specific nodes are tracked. WHEN it runs is
  // `frameChromeScheduler.ts`'s job; WHAT it costs is this:
  //
  //  1. Index read + write (rings, hover ring, selector-affinity pool, node
  //     badge, handles) — every pass. The rects are the index's, in the frame's
  //     own viewport px, which is also the chrome root's coordinate space.
  //  2. Parent-doc anchor (toolbar, InPlaceInspector) — ONLY when
  //     `anchorDirtyRef.current` is true: once on mount, once per selection
  //     change / pan-zoom commit / parent-window resize, and once when the
  //     inspected node's rect actually changed since the last pass (content
  //     reflow — e.g. editing a prop through the inspector that resizes the
  //     element). This is the expensive path (`iframe.getBoundingClientRect()`
  //     + `canvasRoot.getBoundingClientRect()`).
  const place = (iframe: HTMLIFrameElement | null, index: FrameGeometryIndex | null): void => {
    const canvasRoot = portalCanvasRoot

    if (!iframe || !index) {
      // Nothing measurable (iframe not mounted yet / reloading / no adapter):
      // hide everything the pass owns.
      setSelectionBoxed(false)
      for (const ring of ringRefs.current?.values() ?? []) positionOverlayElement(ring, null)
      for (const badge of badgeRefs.current?.values() ?? []) positionNodeBadge(badge, null, null)
      positionOverlayElement(hoverRef.current, null)
      positionResizeFrame(resizeFrameRef.current, null)
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordChromeAnchor(null)
      return
    }

    // ── READ phase: pure arithmetic over the index; the frame is not touched ──
    setSelectionBoxed(selectedNodeIds.length > 0 && selectedNodeIds.every((id) => index.has(id)))
    const ringPlacements: Array<{ id: string; ring: HTMLDivElement | null; rect: CanvasOverlayRect | null }> = []
    for (const id of selectedNodeIds) {
      ringPlacements.push({ id, ring: ringRefs.current?.get(id) ?? null, rect: chromeRectOf(index, framePage, id) })
    }
    const hoverId = showHover ? hoverRingNodeId : null
    const hoverRect = hoverId ? chromeRectOf(index, framePage, hoverId) : null
    const selectorRects = measureSelectorHighlightRects(
      showSelectorHighlight ? highlightedSelector : null,
      frameDocument,
      measureIframeLocalRect,
    )
    const zoom = viewportActions?.transformRef?.current?.zoom ?? 1

    // ── WRITE phase ────────────────────────────────────────────────────────
    for (const { ring, rect } of ringPlacements) positionOverlayElement(ring, rect)
    // Resize handles (and, mid-drag, their W×H badge) ride the SAME rect as the
    // ring, so they cannot drift off the box they belong to. WHETHER they exist
    // is `canOfferResize`'s call, in `CanvasResizeHandles` — no second gate
    // here: re-deriving it is how the two would disagree. P5-F / IX-6g — a
    // multi-selection's handles sit on the union of its rings.
    positionResizeFrame(resizeFrameRef.current, resizeFrameRect(ringPlacements.map((placement) => placement.rect)))
    const hoverRing = hoverRef.current
    if (hoverRing) {
      if (hoverId) hoverRing.setAttribute(OVERLAY_NODE_ID_ATTR, hoverId)
      else hoverRing.removeAttribute(OVERLAY_NODE_ID_ATTR)
      positionOverlayElement(hoverRing, hoverRect)
    }
    syncSelectorHighlightRings(
      selectorHighlightRef.current,
      selectorRects,
      `${chromeStyles.ring} ${chromeStyles.selectorHighlight}`,
    )
    if (designMode && showRings) {
      for (const { id, rect } of ringPlacements) {
        positionNodeBadge(badgeRefs.current?.get(id) ?? null, rect, resolveNodeBadgeLabel(framePage, id, visualComponents), zoom)
      }
    }

    // A pointer gesture that changes layout every frame (an element resize) is
    // the one case this pass's cost model does not cover: the rect below would
    // differ on EVERY frame, marking the anchor dirty and running the
    // "expensive, rare" parent-doc measure session per pointermove. The rings
    // above have already been placed, so they keep tracking the element; the
    // toolbar and inspector simply hold still until the drag ends, and
    // `canvasGesture`'s settle pass recomputes them once. See `canvasGesture.ts`.
    if (isCanvasGestureActive()) return

    // Content-reflow detection: compare THIS pass's selection rects against the
    // last pass's. A real change (a value change, not a reference change) marks
    // the anchor dirty for the branch below, in the SAME pass. Over the whole
    // selection, not just the inspected node: a multi-selection's toolbar must
    // follow a layer that gains its box late (the tree mounting, an image
    // loading), and a pass that found none of them hid the chrome and marked
    // the anchor clean.
    const rectsKey = ringPlacements.map((p) => (p.rect ? `${p.rect.x},${p.rect.y},${p.rect.width},${p.rect.height}` : '-')).join('|')
    if (rectsKey !== lastPlacedRectsKeyRef.current) anchorDirtyRef.current = true
    lastPlacedRectsKeyRef.current = rectsKey

    // ── Parent-doc anchor (expensive, rare) ───────────────────────────────
    const needsAnchor = showToolbar || Boolean(inspectorNodeId)
    if (!needsAnchor) {
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordChromeAnchor(null)
      return
    }
    if (!anchorDirtyRef.current) return

    // `speed-04` — this frame's own placements (just computed, for free) already
    // say whether it renders ANY of the selected nodes at all. When none did, the
    // session below would only ever project `null` for every id — empty union, no
    // inspector rect, both hidden — which the early return here produces without
    // two forced `getBoundingClientRect()` reads. A board frame's own selection is
    // already scoped away for every OTHER frame in the pool, but the CMS/VC canvas
    // mirrors one selection across every real breakpoint frame on purpose — only
    // the frame that actually renders the node should pay for the anchor.
    if (!ringPlacements.some((placement) => placement.rect !== null)) {
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
      recordChromeAnchor(null)
      anchorDirtyRef.current = false
      return
    }

    const session = createCanvasOverlayMeasureSession(iframe, canvasRoot)
    let toolbarUnion: CanvasOverlayRect | null = null
    // The inspector's rect comes from this SAME pass — `null` here means this
    // frame doesn't contain the selected node, which is exactly how the
    // inspector ends up rendered in only the one studio board frame that owns it.
    let inspectorRect: CanvasOverlayRect | null = null
    for (const { id, rect: local } of ringPlacements) {
      const rect = local ? session.project(local) : null
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
    // null — the frame doesn't own the node). A layout read taken mid-reflow can
    // occasionally come back non-finite (e.g. an iframe measured the instant it's
    // mid-resize); committing that as "done" would freeze the toolbar/inspector in
    // a broken position until the NEXT selection change or pan/zoom commit.
    // Leaving `anchorDirtyRef` true instead makes the next pass retry.
    if (overlayRectIsFinite(toolbarUnion) && overlayRectIsFinite(inspectorRect)) {
      anchorDirtyRef.current = false
    }
  }

  const placeOnce = useEffectEvent((): void | Promise<void> => {
    const iframe = iframeElement
    // Same-origin: the index is read in this task, so the whole pass is synchronous. A bridge frame answers a
    // round trip later; a pass started after this one supersedes it, so a slow answer can never overwrite a newer one.
    const now = iframe ? readFrameLocalGeometryNow(iframe) : null
    const generation = (passGenerationRef.current += 1)
    if (!iframe || now) return place(iframe, now)
    return getFrameLocalGeometry(iframe).then((index) => {
      if (generation === passGenerationRef.current) place(iframe, index)
    })
  })

  // The inputs of a placement. A change to any of them places in THIS commit's
  // own task, before the browser paints it (a same-origin frame's index is read
  // synchronously); a bridge frame, whose index is a round trip, lands as soon
  // as it answers. Marking the anchor dirty is half the job: it is the
  // "selection changed / hover moved / pan-zoom committed / tree mutated"
  // trigger the toolbar and inspector re-anchor on.
  useLayoutEffect(() => {
    anchorDirtyRef.current = true
    if (hasOverlayWork) void placeOnce()
  }, [selectedNodeIdsSignature, showToolbar, inspectorNodeId, committedTransform, hoverTargetId, hasOverlayWork, chromeRoot])

  // The two continuous gestures this component can see from RENDER state. A
  // reorder drag moves the tracked element every frame; an animation replay
  // (`animationScrubStore`'s `'playing'` phase, board-wide) does the same for a
  // couple of hundred milliseconds. Everything else that needs a per-frame loop
  // (element resize) is an imperative signal the scheduler subscribes to itself.
  const animationScrub = useCanvasAnimationScrub()
  const continuousGesture = reorderDrag.dragging || animationScrub.phase === 'playing'

  useEffect(() => {
    if (!hasOverlayWork) return

    const scheduler = createFrameChromeScheduler({
      iframeElement,
      measure: placeOnce,
      // A parent-window resize moves the canvas root's own rect, which the
      // rect comparison inside the pass structurally cannot see.
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
  }, [hasOverlayWork, iframeElement, continuousGesture])

  const toolbar = showToolbar ? (
    <SelectionToolbar
      toolbarRef={toolbarRef}
      mode={toolbarMode}
      onDragPointerDown={reorderDrag.handlePointerDown}
      frameId={frameId}
    />
  ) : null

  // One selected layer gets its own handles; several get ONE set on their
  // union (P5-F, IX-6g — `CanvasGroupResizeHandles`), which scales them as a
  // group in one write — a same-origin frame only. A live frame's single
  // selection gets the same handles, its drag driven over the wire.
  const resizeNodeIds =
    designMode && showRings && selectionBoxed && (frameDocument ? true : bridgeChrome && selectedNodeIds.length === 1)
      ? selectedNodeIds
      : EMPTY_SELECTED_NODE_IDS
  // `live-13` — a bridge frame's resize target: what its runtime needs to size the element the parent's handles drag.
  useBridgeResizeTarget(bridgeChrome ? adapter : null, {
    selectedNodeIds: showRings ? selectedNodeIds : EMPTY_SELECTED_NODE_IDS,
    committedTransform,
  })
  // This component owns `resizeFrameRef`, so this component writes it —
  // the chrome below is handed a setter, never the ref.
  const setResizeFrameElement = (element: HTMLDivElement | null) => {
    resizeFrameRef.current = element
  }

  // PERF-2 — the hover ring is hidden by a style write, never unmounted, so a
  // hover crossing is an attribute change, not a mount. Layout effect: hidden
  // before the first paint of a freshly mounted chrome too.
  useLayoutEffect(() => {
    if (!showHover) {
      hideOverlayElement(hoverRef.current)
      hoverRef.current?.removeAttribute(OVERLAY_NODE_ID_ATTR)
    }
  }, [showHover, chromeRoot])

  // The press ring borrows this frame's hover ring (`pressRing.ts`).
  useEffect(() => {
    if (!iframeElement || !chromeRoot) return
    return registerFrameChrome(iframeElement, { hoverRing: () => hoverRef.current })
  }, [iframeElement, chromeRoot])

  // Studio-only mini-inspector (Phase 2), anchored below the selection ring; any drag end closes it.
  const inspectorClosed = useInspectorClosedAfterDrag(reorderDrag.dragging, selectedNodeIdsSignature, selectedNodeIds.length > 0)
  const inspector = inspectorNodeId && !inspectorClosed ? (
    <InPlaceInspectorAnchor anchorRef={inspectorRef} nodeId={inspectorNodeId} mode={toolbarMode} breakpointId={breakpointId} />
  ) : null

  return (
    <>
      {/* React renders an EMPTY layer inside the breakpoint viewport; the drag
          session paints the drop line, the refusal chip and the ghost into it.
          See `CanvasDropIndicators` / `canvasDragPainter`. */}
      <CanvasDropIndicators layerRef={reorderDrag.dropLayerRef} />
      {/* The chrome root: rings, badges and handles, in this frame's viewport px
          beside the iframe. Zero-size and click-through; see the module doc. */}
      {showRings && (
        <div ref={setChromeRoot} className={chromeStyles.root} data-canvas-frame-chrome="true">
          <CanvasSelectionChrome
            selectedNodeIds={selectedNodeIds}
            showSelectorHighlight={showSelectorHighlight}
            resizeNodeIds={resizeNodeIds}
            frameDocument={frameDocument}
            iframeElement={iframeElement}
            designMode={designMode}
            selectorHighlightRef={selectorHighlightRef}
            hoverRef={hoverRef}
            ringRefs={ringRefs}
            badgeRefs={badgeRefs}
            onResizeFrameReady={setResizeFrameElement}
          />
          {/* K5 — Alt-hover measurements. Owns its own Alt/visibility state and
              renders nothing until the gesture is live; see `MeasureLayer`. */}
          <MeasureLayer iframeElement={iframeElement} selectedNodeIds={selectedNodeIds} hoveredNodeId={hoveredNodeId} />
        </div>
      )}
      {toolbar && portalTarget && createPortal(toolbar, portalTarget)}
      {inspector && portalTarget && createPortal(inspector, portalTarget)}
      {treeLadder.portal}
    </>
  )
}
