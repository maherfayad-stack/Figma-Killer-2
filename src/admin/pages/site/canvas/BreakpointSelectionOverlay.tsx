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
 * wrapper.
 *
 * Everything else
 * ────────────────
 * - One overlay per breakpoint frame. Drop indicators stay inside the
 *   breakpoint viewport (they only appear during a drag, and the
 *   transform-scaled coordinate path is established for them).
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

import { use, useEffect, useEffectEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import {
  getNodeDisplayName,
  getNodeHtmlTag,
  styleRuleSelector,
  type Page,
} from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { VisualComponent } from '@core/visualComponents'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@ui/cn'
import { CanvasPageContext, CanvasViewportActionsContext } from './CanvasContexts'
import { SelectionToolbar } from './SelectionToolbar'
import { useCanvasReorderDrag } from './useCanvasReorderDrag'
import { useCanvasTreeLadderOverlay } from './CanvasTreeLadderOverlay'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import { InPlaceInspector } from './InPlaceInspector'
import {
  createCanvasOverlayMeasureSession,
  measureIframeLocalRect,
  unionCanvasOverlayRects,
  type CanvasOverlayRect,
} from './canvasOverlayGeometry'
import type { CanvasRectSource } from './canvasDomGeometry'
import {
  dropIndicatorStyle,
  hideOverlayElement,
  measureSelectorHighlightRects,
  positionInspector,
  positionNodeBadge,
  positionOverlayElement,
  positionToolbar,
  publishSelectionAnchor,
  rectStyle,
  syncSelectorHighlightRings,
} from './canvasSelectionOverlayPositioning'
import styles from './BreakpointSelectionOverlay.module.css'

const EMPTY_VISUAL_COMPONENTS: readonly VisualComponent[] = []
/** Stable empty fallback for the frame-scoped selection read below (Guideline #239 — no inline `?? []`). */
const EMPTY_SELECTED_NODE_IDS: readonly string[] = []

/** Two nullable rects are equal when every field matches (or both are null). */
function overlayRectsEqual(a: CanvasOverlayRect | null, b: CanvasOverlayRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** `null` (frame doesn't own the node — legitimate) or every field a finite number. */
function overlayRectIsFinite(rect: CanvasOverlayRect | null): boolean {
  if (!rect) return true
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}

/**
 * The node's tag or display name for the in-iframe node badge (WS-5.1) —
 * same fallback order the Alt-hover tree ladder rows already use
 * (`CanvasTreeLadderRowButton`).
 */
function resolveNodeBadgeLabel(
  page: Page | null,
  nodeId: string,
  visualComponents: ReadonlyArray<VisualComponent>,
): string | null {
  const node = page?.nodes[nodeId]
  if (!node) return null
  const definition = registry.get(node.moduleId)
  return getNodeHtmlTag(node, definition) || getNodeDisplayName(node, definition, visualComponents) || null
}

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
  // Multi-select: render one ring per selected node. `useShallow` keeps the
  // subscription stable when the array reference changes but its contents
  // are equal (matters because selectedNodeIds is a new array every set call).
  //
  // WS-10 Phase 2 — frame-scoped when the selection originated from a board
  // frame (`selectedNodeFrameId` set): a "duplicate as variant" sibling of
  // the same page shares every node id (trap #2), so without this an
  // rtl/dark variant would show the SAME selection ring as its light/ltr
  // sibling. `null` origin (every CMS/VC selection) keeps the existing
  // "every frame mirrors the selection" behaviour — see the module doc.
  const selectedNodeIds = useEditorStore(useShallow((s) =>
    s.selectedNodeFrameId === null || s.selectedNodeFrameId === frameId
      ? s.selectedNodeIds
      : EMPTY_SELECTED_NODE_IDS,
  ))
  // `hoveredBreakpointId === null` means "global hover" — i.e. the hover did
  // not originate from a specific breakpoint frame on the canvas (e.g. it was
  // triggered by hovering a row in the DOM panel). In that case every frame
  // mirrors the hover so the user sees the highlight wherever they're looking.
  // When the hover originated from the canvas itself, scope it to the owning
  // frame so adjacent breakpoint previews don't all light up at once.
  // `hoveredFrameId` is the SAME idea one dimension over — see its own doc.
  const hoveredNodeId = useEditorStore((s) =>
    s.hoveredNodeId &&
    (s.hoveredBreakpointId === null || s.hoveredBreakpointId === breakpointId) &&
    (s.hoveredFrameId === null || s.hoveredFrameId === frameId)
      ? s.hoveredNodeId
      : null,
  )
  const hoveredBreakpointOrigin = useEditorStore((s) => s.hoveredBreakpointId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)

  // Selector-affinity highlight: the CSS selector of the rule currently hovered
  // in the Selectors panel, or null. Resolved to its selector string here so the
  // RAF tick can `querySelectorAll` it inside the iframe and ring every match.
  // Like the DOM-panel hover, this is a global highlight — every breakpoint
  // frame mirrors it, so the user sees the affinity wherever they're looking.
  const highlightedSelector = useEditorStore((s) => {
    const classId = s.highlightedSelectorClassId
    if (!classId) return null
    const rule = s.site?.styleRules[classId]
    return rule ? styleRuleSelector(rule) : null
  })
  // THIS frame's page (board: one page per frame) — O(1) node-map reads for the
  // in-iframe badge label (WS-5.1) and the zero-DOM fragment-node rect fallback.
  const framePageId = use(CanvasPageContext)
  const framePage = useEditorStore((s) => selectCanvasPageFor(s, framePageId))
  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_VISUAL_COMPONENTS)
  // One ref per selected node, keyed by id. Stable across renders while the
  // id stays in the selection — when an id is removed, its ring entry is
  // dropped from the map; when added, a fresh ref is allocated.
  const ringRefs = useRef<Map<string, HTMLDivElement | null> | null>(null)
  if (ringRefs.current === null) ringRefs.current = new Map()
  // One badge per selected node, same keying discipline as ringRefs.
  const badgeRefs = useRef<Map<string, HTMLDivElement | null> | null>(null)
  if (badgeRefs.current === null) badgeRefs.current = new Map()
  const hoverRef = useRef<HTMLDivElement>(null)
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
  const viewportActions = use(CanvasViewportActionsContext)

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
  const anyEditCap =
    permissions.canEditStructure || permissions.canEditContent || permissions.canEditStyle
  const showRings = anyEditCap
  const showSelectorHighlight = showRings && Boolean(highlightedSelector)
  const showToolbar =
    permissions.canEditStructure &&
    selectedNodeIds.length > 0 &&
    activeBreakpointId === breakpointId

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
  }, [selectedNodeIdsSignature, showToolbar, inspectorNodeId, committedTransform])

  // Prefer the canvas root as the portal target so overlay chrome sits inside
  // the canvas's stacking + clipping context. The root is captured into state
  // after mount so the portal target and measurement coordinate space switch
  // together instead of leaving body-portaled chrome positioned with
  // canvas-root-local coordinates during the ref-availability race.
  const portalTarget = portalCanvasRoot ?? document.body
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
  })
  // Hover only renders when the hovered node isn't already part of the
  // selection — otherwise the two rings would stack and the hover ring
  // would mask the selection ring. In Alt/Option inspect mode, the ladder
  // highlight becomes the hover ring target so keyboard navigation is visible.
  const hoverRingNodeId = treeLadder.hoverNodeId ?? hoveredNodeId
  const showHover = Boolean(hoverRingNodeId) && !selectedNodeIds.includes(hoverRingNodeId ?? '')
  const reorderDrag = useCanvasReorderDrag({
    viewportRef,
    iframeElement,
    selectedNodeIds,
    enabled: showToolbar,
    panBy: viewportActions?.panBy,
    canvasRootRef: viewportActions?.canvasRootRef,
  })

  // Each RAF tick reads the freshest selection / hover / toolbar inputs from
  // the latest render closure via useEffectEvent. Because the tick always reads
  // the latest values, the effect only needs to re-arm when the loop should
  // start or stop — gated by `hasOverlayWork` below — not on every change to
  // which specific nodes are tracked.
  //
  // WS-5.1: the tick now does two very differently-priced things.
  //
  //  1. Iframe-local read + write (rings, hover ring, selector-affinity pool,
  //     node badge) — EVERY tick. `measureIframeLocalRect` reads the target's
  //     rect directly (no zoom recovery, no iframe-offset addition, no
  //     canvas-root origin subtraction — see its own docblock), because these
  //     elements are portaled into `overlayRoot`, which lives in the SAME
  //     iframe document as the elements they track. Panning/zooming moves the
  //     whole iframe (and this overlay with it) as one composited transform,
  //     so this is correct at every zoom level with zero conversion.
  //  2. Parent-doc anchor (toolbar, InPlaceInspector) — ONLY when
  //     `anchorDirtyRef.current` is true: once on mount, once per selection
  //     change / pan-zoom commit (the effect above), and once when the
  //     inspected node's cheap iframe-local rect actually changed since the
  //     last tick (content reflow — e.g. editing a prop through the inspector
  //     that resizes the element). This is the expensive path
  //     (`iframe.getBoundingClientRect()` + `canvasRoot.getBoundingClientRect()`,
  //     the same zoom-multiplied math that caused `standing-03`'s drift) —
  //     paying for it only on these real, infrequent events (never per
  //     pointermove) is the whole point of WS-5.1's bounded-cost requirement.
  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null) => {
    const canvasRoot = portalCanvasRoot
    const iframeDoc = iframe?.contentDocument ?? null
    const elementCache = nodeElementCacheRef.current!

    if (!iframe || !iframeDoc) {
      // Nothing measurable (iframe not mounted yet / reloading). Rings/hover/
      // selector-highlight/badge now live INSIDE the iframe document, so when
      // it's gone there is nothing there to hide — only the parent-doc
      // toolbar/inspector need an explicit hide.
      hideOverlayElement(toolbarRef.current)
      hideOverlayElement(inspectorRef.current)
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
    const ringPlacements: Array<{ id: string; ring: HTMLDivElement | null; rect: CanvasOverlayRect | null }> = []
    for (const id of selectedNodeIds) {
      trackedIds.add(id)
      const rect = measureRing(elementCache.resolve(iframeDoc, id, framePage))
      ringPlacements.push({ id, ring: ringRefs.current?.get(id) ?? null, rect })
    }

    const hoverId = showHover ? hoverRingNodeId : null
    let hoverRect: CanvasOverlayRect | null = null
    if (hoverId) {
      trackedIds.add(hoverId)
      hoverRect = measureRing(elementCache.resolve(iframeDoc, hoverId, framePage))
    }
    elementCache.retainOnly(trackedIds)

    const selectorRects = measureSelectorHighlightRects(
      showSelectorHighlight ? highlightedSelector : null,
      iframeDoc,
      measureRing,
    )

    // ── Ring/badge WRITE phase ────────────────────────────────────────────
    for (const { ring, rect } of ringPlacements) positionOverlayElement(ring, rect)
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
      return
    }
    if (!anchorDirtyRef.current) return

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

  // The RAF loop exists to re-position overlay chrome as the tracked element
  // moves (scroll, layout shift, zoom/pan, content animation). When there is
  // nothing to track — no selection rings, no hover ring, no selector-affinity
  // rings, no toolbar — there is no work to do, so the loop must not run.
  // Without this guard every breakpoint frame keeps a permanent 60fps RAF loop
  // alive that ticks idle helpers forever and prevents the main thread from
  // sleeping (N frames → N idle loops). The effect re-arms whenever this flag
  // flips, so the loop starts the moment real overlay work appears.
  const hasOverlayWork =
    showToolbar ||
    showSelectorHighlight ||
    (showRings && (selectedNodeIds.length > 0 || showHover))

  useEffect(() => {
    if (!hasOverlayWork) return

    let frame = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      tickOnce(iframeElement)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [hasOverlayWork, iframeElement])

  const toolbar = showToolbar ? (
    <SelectionToolbar
      toolbarRef={toolbarRef}
      mode={toolbarMode}
      dragging={reorderDrag.dragging}
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
  const legacyRingClassName = (variant: 'selection' | 'hover') =>
    usingIframeOverlay ? undefined : cn(styles.ring, styles[variant])
  const legacyRingMode = usingIframeOverlay ? undefined : toolbarMode
  const canvasChrome = showRings && (selectedNodeIds.length > 0 || (showHover && hoverRingNodeId) || showSelectorHighlight) ? (
    <>
      {/* Orange affinity rings — populated imperatively by the RAF tick, one
          per element matching the hovered selector. */}
      {showSelectorHighlight && (
        <div ref={selectorHighlightRef} data-canvas-selector-highlight-layer="true" />
      )}
      {/* `data-canvas-overlay-node-id`, NOT `data-node-id`: when hosted inside
          the iframe (WS-5.1), these elements live in the SAME document as
          authored content. `data-node-id` is the contract many other
          subsystems query on inside a canvas iframe — drag/drop candidate
          measurement (`measureCanvasDropCandidates`'s `[data-node-id]` scan),
          `findRenderedCanvasNodes`/`CanvasNodeElementCache`'s node
          resolution, plugin `useCanvasNodeRect` — carrying it here would
          make chrome masquerade as a second, ring-shaped copy of the
          authored node wherever those scans run. The correlating id below is
          JS-only bookkeeping (ref maps, the e2e/test hook), never a selector
          any other subsystem treats as "this is an authored node". */}
      {selectedNodeIds.map((id) => (
        <div
          key={`ring-${id}`}
          ref={(el) => {
            if (el) ringRefs.current?.set(id, el)
            else ringRefs.current?.delete(id)
          }}
          className={legacyRingClassName('selection')}
          data-canvas-ring-mode={legacyRingMode}
          data-canvas-selection-ring="true"
          data-canvas-overlay-node-id={id}
        />
      ))}
      {/* Node-name badge (WS-5.1) — design-mode only (see props doc): one per
          selected node, anchored just above its ring by `positionNodeBadge`.
          Text set imperatively. No badge for the hover ring or
          selector-affinity pool (transient affordances, not a deliberate
          selection), and none in the live-mode fallback — the badge is a
          WS-5.1 addition, not a pre-existing affordance to preserve there. */}
      {usingIframeOverlay && selectedNodeIds.map((id) => (
        <div
          key={`badge-${id}`}
          ref={(el) => {
            if (el) badgeRefs.current?.set(id, el)
            else badgeRefs.current?.delete(id)
          }}
          data-canvas-node-badge="true"
          data-canvas-overlay-node-id={id}
        />
      ))}
      {showHover && hoverRingNodeId && (
        <div
          ref={hoverRef}
          className={legacyRingClassName('hover')}
          data-canvas-ring-mode={legacyRingMode}
          data-canvas-hover-ring="true"
          data-canvas-overlay-node-id={hoverRingNodeId}
        />
      )}
    </>
  ) : null

  // Studio-only mini-inspector (Phase 2): anchored just below the selection
  // ring by the RAF tick's `positionInspector` call above, using the same
  // measured rect the ring already used. `InPlaceInspector` independently
  // bails to null for a non-`alm.*` node, so this wrapper mounts for any
  // single studio selection and the component itself decides whether to
  // render anything.
  const inspector = inspectorNodeId ? (
    <div
      ref={inspectorRef}
      className={styles.inspectorAnchor}
      data-canvas-in-place-inspector="true"
      data-canvas-inspector-mode={toolbarMode}
      // Debugging aid: every studio board frame mounts its OWN wrapper (see
      // `showInspector`'s comment above), so several of these can exist in
      // the DOM at once with only one actually positioned/visible — this
      // makes it possible to tell them apart without walking React internals.
      data-canvas-inspector-breakpoint={breakpointId}
      // Same rationale as the toolbar's onClick guard: the inspector is
      // portaled into the canvas root, whose background click clears the
      // selection — without this guard, clicking a control inside it would
      // bubble up and clear the selection mid-edit.
      onClick={(event) => event.stopPropagation()}
    >
      <InPlaceInspector nodeId={inspectorNodeId} />
    </div>
  ) : null

  return (
    <>
      {/* Drop indicators stay inside the breakpoint viewport — they only
          appear transiently during a drag, and the transform-scaled
          coordinate path is established for them via `dropIndicatorStyle`. */}
      <div className={styles.overlayLayer}>
        {reorderDrag.target && (
          <div
            className={styles.dropIndicator}
            data-position={reorderDrag.target.position}
            data-axis={reorderDrag.target.axis}
            style={dropIndicatorStyle(reorderDrag.target)}
            aria-hidden="true"
          />
        )}

        {reorderDrag.invalid && (
          <div
            className={styles.invalidDropIndicator}
            style={rectStyle(reorderDrag.invalid.rect)}
            data-axis={reorderDrag.invalid.axis}
            // G5 — present when this box means "this position would refuse
            // the source write" (a real drop target the store's own gate
            // would still reject — shared component, route chrome, …),
            // distinct from an ordinary structural rejection (locked node,
            // cycle) which carries no message. `reorderDrag.invalid.
            // refusalMessage` holds the full sentence for a FUTURE
            // cursor-following label — not wired up to a visible tooltip
            // here: this element is `pointer-events: none` (so a native
            // `title` would never fire) and a real label needs a small
            // positioned component this pass didn't build. The red box
            // itself is what ships today — previously this exact case
            // (a structurally valid position the write would still refuse)
            // rendered a confident VALID drop line instead.
            data-refusal-reason={reorderDrag.invalid.refusalMessage ? 'source-writeback' : undefined}
            aria-hidden="true"
          />
        )}
      </div>
      {canvasChrome && createPortal(canvasChrome, overlayRoot ?? portalTarget)}
      {toolbar && createPortal(toolbar, portalTarget)}
      {inspector && createPortal(inspector, portalTarget)}
      {treeLadder.portal}
    </>
  )
}
