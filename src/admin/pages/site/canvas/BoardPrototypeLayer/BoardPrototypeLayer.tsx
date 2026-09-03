/**
 * BoardPrototypeLayer — the connectors, and the `+` handle that draws them.
 *
 * Mounted inside `CanvasTransformLayer` (via `StudioBoardLayers`), so it
 * inherits the canvas pan/zoom transform and everything it draws is in plain
 * board units. Renders `null` outside prototype mode, which is most of the
 * time — design mode never shows a connector, and the publisher never sees one.
 *
 * WHY EVERY PIECE OF PROTOTYPE CHROME IS IN THIS ONE PARENT LAYER
 * ──────────────────────────────────────────────────────────────
 * Selection rings are portaled INTO each frame's document to dodge coordinate
 * conversion. A connector cannot use that trick: it spans two iframes and there
 * is no document containing both. So the connector has to live in the parent,
 * and once it does, putting the `+` handle inside the frame instead would mean
 * two coordinate systems for one gesture — the handle would be measured one way
 * and the rubber band it starts another. One layer, one space.
 *
 * EVERY DROP TARGET IS AN IFRAME
 * ──────────────────────────────
 * A left-click pointer event inside an iframe never reaches the parent
 * document's `window`, so a parent-doc drag goes silent the instant the cursor
 * enters a frame — and here the frames ARE the targets, so the gesture died on
 * contact with the only thing it was aiming at. It worked perfectly over empty
 * board, which is what made it read as "the drop does nothing" rather than "the
 * drag stopped". `markCanvasPointerRelay` is what makes each frame forward
 * move/up/cancel back out for the duration.
 *
 * THREE ARCHITECTURE GATES SIT DIRECTLY ON THIS FILE
 * ─────────────────────────────────────────────────
 *   - `single-drag-mechanism.test.ts` bans `@dnd-kit` and the native HTML5
 *     drag-and-drop transfer API in new files, so the connector drag is built
 *     from raw pointer events.
 *   - `canvas-overlay-pointerdown.test.ts` bans `stopPropagation` in
 *     `onPointerDown` anywhere under `canvas/` — it poisons use-gesture's tap
 *     state and then eats the next click ANYWHERE on the canvas.
 *     `preventDefault` only.
 *   - `canvas-drag-pointer-relay.test.ts` requires the relay above of every
 *     canvas drag that listens on the parent `window`. It exists because this
 *     file is the third to need it and the first two only knew by accident.
 */
import { useContext, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames } from '@site/store/slices/boardSelectors'
import { commitLinkDraft } from '@site/studio/prototypeActions'
import { visibleLinks } from '@site/store/slices/prototypeSelectors'
import { actionTakesTarget, resolveLinkSource, type PrototypeLink } from '@core/studio-prototype'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from '../canvasPointerRelay'
import { screenToBoard } from '../CanvasRulers/rulerGeometry'
import {
  frameAtBoardPoint,
  handlePoint,
  routeConnector,
  routeDraftConnector,
  routesBounds,
  type BoardPoint,
  type BoardRect,
  type ConnectorRoute,
} from './connectorGeometry'
import { frameBoardRect, toBoardRect, useNodeFrameRects } from './usePrototypeEndpoints'
import { usePrototypeLinkPick } from './usePrototypeLinkPick'
import styles from './BoardPrototypeLayer.module.css'

/** Stable identity so the measuring hook does not rebuild its observer. */
const EMPTY_IDS: string[] = []

export function BoardPrototypeLayer() {
  const boardMode = useEditorStore((s) => s.boardMode)
  const frames = useEditorStore(selectActiveBoardFrames)
  const authoredLinks = useEditorStore((s) => s.prototype.links)
  const selectedLinkId = useEditorStore((s) => s.selectedLinkId)
  const setSelectedLink = useEditorStore((s) => s.setSelectedLink)
  const linkDraft = useEditorStore((s) => s.linkDraft)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)

  // Both store reads above are STABLE references. Everything derived from them
  // is computed here in the render body, never inside `useEditorStore` — a
  // selector that builds a fresh array is an infinite render loop, because
  // zustand compares with `Object.is` and a new array is never equal to the
  // last one. See `prototypeSelectors`' module doc.
  const pages = useEditorStore((s) => s.site?.pages)

  // Authored links merged with the ones derived from the user's navigation
  // code. Only computed in prototype mode — the derivation walks every node of
  // every loaded page, and design mode never draws a connector.
  const links = boardMode === 'prototype' ? visibleLinks(authoredLinks, pages) : authoredLinks

  // Resolve each link's source element against the live tree BEFORE measuring:
  // a stored node id is a guess about a line number, and the id that actually
  // renders may have moved. `resolveLinkSource` is what knows the difference.
  const resolvedSourceIds = new Map<string, string>()
  if (boardMode === 'prototype') {
    for (const link of links) {
      const page = pages?.find((candidate) => candidate.id === link.source.pageId)
      const nodeId = resolveLinkSource(link.source.node, page ?? null).nodeId
      if (nodeId) resolvedSourceIds.set(link.id, nodeId)
    }
  }

  // The `+` handle needs the same measurement as a connector's source, so it
  // rides the same observer rather than opening a second one. Sorted so the
  // hook's join key is stable under map-iteration order changes.
  // The toolbar's pending request has to be measured too, or the pick it asked
  // for can never resolve an anchor to draw from.
  const pendingLinkSource = useEditorStore((s) => s.pendingLinkSource)
  const measuredIds = [
    ...new Set([
      ...resolvedSourceIds.values(),
      ...(selectedNodeId ? [selectedNodeId] : []),
      ...(pendingLinkSource ? [pendingLinkSource.nodeId] : []),
    ]),
  ].sort()
  const localRects = useNodeFrameRects(boardMode === 'prototype' ? measuredIds : EMPTY_IDS)

  // The selection toolbar's entry point into the same draft this layer draws.
  // Called before the early return below, because a hook has to be.
  usePrototypeLinkPick(localRects)

  if (boardMode !== 'prototype') return null

  const frameByPage = new Map<string, BoardRect>()
  for (const frame of frames) {
    // First frame wins for a page with variant frames: a link belongs to the
    // PAGE, so drawing it once is the honest single answer. Drawing it from
    // every variant would multiply one link into N identical connectors.
    if (!frameByPage.has(frame.pageId)) frameByPage.set(frame.pageId, frameBoardRect(frame))
  }

  const sourceRectFor = (pageId: string, nodeId: string | null): BoardRect | null => {
    const frameRect = frameByPage.get(pageId)
    const local = nodeId ? localRects.get(nodeId) : undefined
    return frameRect && local ? toBoardRect(frameRect, local) : null
  }

  const drawn: Array<{ link: PrototypeLink; route: ConnectorRoute }> = []
  // A `back` or a `close` names no screen, so it has no connector to draw —
  // and an interaction you cannot see on the board is one you will forget you
  // authored. Each gets a chip on its own element instead.
  const badges: Array<{ link: PrototypeLink; point: BoardPoint }> = []

  for (const link of links) {
    const source = sourceRectFor(link.source.pageId, resolvedSourceIds.get(link.id) ?? null)
    if (!source) continue

    if (!actionTakesTarget(link.action)) {
      badges.push({ link, point: handlePoint(source) })
      continue
    }

    const target = link.targetPageId ? frameByPage.get(link.targetPageId) : undefined
    if (!target) continue
    drawn.push({ link, route: routeConnector(source, target) })
  }

  // The frame the cursor is currently over, if any. Drives both the snap and
  // the wash below — one source for "this is where it will land".
  const hoveredRect = linkDraft?.hoverPageId ? (frameByPage.get(linkDraft.hoverPageId) ?? null) : null

  let draftRoute: ConnectorRoute | null = null
  if (linkDraft) {
    const from: BoardRect = { x: linkDraft.fromX, y: linkDraft.fromY, width: 0, height: 0 }
    // Snapped: once the cursor is over a frame the band leaves the cursor and
    // lands on that frame's edge, routed exactly as `routeConnector` will route
    // the committed link. A rubber band that keeps chasing the cursor over a
    // valid target is a drag that never says whether releasing will do anything.
    draftRoute = hoveredRect
      ? routeConnector(from, hoveredRect)
      : routeDraftConnector(from, { x: linkDraft.toX, y: linkDraft.toY })
  }

  const bounds = routesBounds(draftRoute ? [...drawn.map((d) => d.route), draftRoute] : drawn.map((d) => d.route))

  return (
    <div className={styles.layer} data-testid="board-prototype-layer">
      {bounds && (
        <svg
          className={styles.canvas}
          style={
            {
              '--connector-x': `${bounds.x}px`,
              '--connector-y': `${bounds.y}px`,
              '--connector-w': `${bounds.width}px`,
              '--connector-h': `${bounds.height}px`,
            } as CSSProperties
          }
          viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
          width={bounds.width}
          height={bounds.height}
        >
          {drawn.map(({ link, route }) => (
            <g key={link.id} className={styles.connector} data-selected={link.id === selectedLinkId ? 'true' : undefined}>
              {/* A 2px curve is a 2px hit target. The invisible fat stroke
                  underneath is what makes a connector clickable at all. */}
              <path className={styles.hitArea} d={route.path} onPointerDown={() => setSelectedLink(link.id)} />
              <path className={styles.line} d={route.path} data-origin={link.origin} />
              {/* Radii come from the stylesheet, which divides by the live
                  canvas zoom — a fixed `r` here would be a board-unit size
                  and shrink to a speck on a fitted board. */}
              <circle className={styles.origin} cx={route.from.x} cy={route.from.y} />
              <circle className={styles.endpoint} cx={route.to.x} cy={route.to.y} />
            </g>
          ))}

          {draftRoute && <path className={styles.draftLine} d={draftRoute.path} />}
        </svg>
      )}

      {hoveredRect && (
        <div
          className={styles.dropTarget}
          data-testid="prototype-drop-target"
          aria-hidden="true"
          style={
            {
              '--drop-x': `${hoveredRect.x}px`,
              '--drop-y': `${hoveredRect.y}px`,
              '--drop-w': `${hoveredRect.width}px`,
              '--drop-h': `${hoveredRect.height}px`,
            } as CSSProperties
          }
        />
      )}

      {badges.map(({ link, point }) => (
        <button
          key={link.id}
          type="button"
          className={styles.badge}
          data-selected={link.id === selectedLinkId ? 'true' : undefined}
          aria-label={`${link.action === 'back' ? 'Go back' : 'Close overlay'} — prototype interaction`}
          style={{ '--badge-x': `${point.x}px`, '--badge-y': `${point.y}px` } as CSSProperties}
          onPointerDown={() => setSelectedLink(link.id)}
        >
          {link.action === 'back' ? 'Back' : 'Close'}
        </button>
      ))}

      <PrototypeHandle localRects={localRects} />
    </div>
  )
}

/**
 * The `+` beside the selected element. Dragging it to another frame authors a
 * link; releasing over empty board cancels.
 */
function PrototypeHandle({ localRects }: { localRects: ReadonlyMap<string, BoardRect> }) {
  const viewportActions = useContext(CanvasViewportActionsContext)
  const frames = useEditorStore(selectActiveBoardFrames)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activePageId = useEditorStore((s) => s.activePageId)
  const beginLinkDraft = useEditorStore((s) => s.beginLinkDraft)
  const updateLinkDraft = useEditorStore((s) => s.updateLinkDraft)
  const cancelLinkDraft = useEditorStore((s) => s.cancelLinkDraft)
  const dragging = useRef(false)

  if (!selectedNodeId || !activePageId) return null

  const frame = frames.find((f) => f.pageId === activePageId)
  if (!frame) return null

  const local = localRects.get(selectedNodeId)
  if (!local) return null
  const sourceRect = toBoardRect(frameBoardRect(frame), local)

  const anchor = handlePoint(sourceRect)

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    if (!viewportActions) return
    // `preventDefault` only, never `stopPropagation` — see this module's doc.
    event.preventDefault()
    dragging.current = true

    // Keep the pointer stream alive across the iframe boundary. Capture holds
    // it while the cursor is still over the parent doc; the relay flag takes
    // over the moment it enters a frame. Without BOTH, every listener below
    // stops firing as soon as the cursor reaches a page — see this module's doc.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Some test envs / older browsers reject capture; the relay alone still
        // carries the gesture, which is the half that crosses the boundary.
      }
    }
    markCanvasPointerRelay(event.pointerId)

    const { canvasRootRef, transformRef } = viewportActions
    const frameRects = frames.map((f) => ({ ...frameBoardRect(f), pageId: f.pageId }))

    const toBoard = (e: PointerEvent): BoardPoint | null => {
      const root = canvasRootRef.current
      if (!root) return null
      const rect = root.getBoundingClientRect()
      const t = transformRef.current
      return {
        x: screenToBoard(e.clientX - rect.left, t.zoom, t.panX),
        y: screenToBoard(e.clientY - rect.top, t.zoom, t.panY),
      }
    }

    beginLinkDraft({
      sourcePageId: activePageId,
      sourceNodeId: selectedNodeId,
      fromX: anchor.x,
      fromY: anchor.y,
      toX: anchor.x,
      toY: anchor.y,
      hoverPageId: null,
      mode: 'drag',
    })

    const onMove = (e: PointerEvent) => {
      const point = toBoard(e)
      if (!point) return
      const hovered = frameAtBoardPoint(frameRects, point)
      updateLinkDraft({
        toX: point.x,
        toY: point.y,
        // A link from a screen to itself is not a navigation, so the source
        // frame never counts as a drop target.
        hoverPageId: hovered && hovered.pageId !== activePageId ? hovered.pageId : null,
      })
    }

    const finish = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', onCancel)
      clearCanvasPointerRelay()
      if (!dragging.current) return
      dragging.current = false

      const point = toBoard(e)
      const hovered = point ? frameAtBoardPoint(frameRects, point) : null
      if (hovered && hovered.pageId !== activePageId) {
        void commitLinkDraft(hovered.pageId)
        return
      }
      // Released over empty board, or back on the source screen: nothing was
      // drawn, so nothing is left behind.
      cancelLinkDraft()
    }

    const onCancel = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', onCancel)
      clearCanvasPointerRelay()
      dragging.current = false
      cancelLinkDraft()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', onCancel)
  }

  return (
    <button
      type="button"
      className={styles.handle}
      aria-label="Draw a prototype link from this element"
      data-testid="prototype-link-handle"
      style={{ '--handle-x': `${anchor.x}px`, '--handle-y': `${anchor.y}px` } as CSSProperties}
      onPointerDown={onPointerDown}
    >
      +
    </button>
  )
}
