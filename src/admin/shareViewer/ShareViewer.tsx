/**
 * The share viewer — the whole application at `/share/<token>`.
 *
 * It fetches one JSON manifest, lays out one `<img>` per frame at the board
 * coordinates the designer arranged them in, and lets the visitor pan and
 * zoom. That is all of it. There is no store, no canvas, no module registry,
 * no selection, no editing, and no request that is not one of the two the
 * share route serves.
 *
 * ## Why the transform math is hand-rolled rather than `useCanvas`
 *
 * The editor's canvas hook is the right thing for the editor: it carries
 * selection hit-testing, snapping, marquee, rulers, frame chrome, scroll
 * unroll, and a store subscription. A viewer needs one 3×3 affine transform
 * and two gestures. Reusing the hook would drag the editor's entire
 * dependency graph into a bundle served to strangers, which is precisely what
 * the separate entry exists to prevent — so the twenty lines below are not a
 * duplicated abstraction, they are the whole feature.
 *
 * Gestures follow the convention the visitor most likely already has from a
 * design tool: wheel/trackpad scrolls the board, ctrl (or ⌘) + wheel zooms
 * about the pointer, and dragging anywhere pans. The zoom controls in the
 * footer exist because a first-time viewer should not have to guess.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest, ApiError } from '@core/http'
import { Button } from '@ui/components/Button'
import { shareBoardJsonPath, shareFrameImagePath, SharedBoardSchema, type SharedBoard } from '@core/studio-share'
import { ShareUnavailable } from './ShareUnavailable'
import styles from './ShareViewer.module.css'

const MIN_SCALE = 0.05
const MAX_SCALE = 4
/** Padding around the fitted board, as a fraction of the viewport. */
const FIT_MARGIN = 0.92

interface Viewport {
  x: number
  y: number
  scale: number
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; board: SharedBoard }
  | { status: 'unavailable' }

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** The transform that centres every frame in `board` inside a `width × height` viewport. */
function fitViewport(board: SharedBoard, width: number, height: number): Viewport {
  if (board.frames.length === 0 || width === 0 || height === 0) return { x: 0, y: 0, scale: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const frame of board.frames) {
    minX = Math.min(minX, frame.x)
    minY = Math.min(minY, frame.y)
    maxX = Math.max(maxX, frame.x + frame.width)
    maxY = Math.max(maxY, frame.y + frame.height)
  }
  const boardWidth = Math.max(1, maxX - minX)
  const boardHeight = Math.max(1, maxY - minY)
  const scale = clampScale(Math.min((width / boardWidth) * FIT_MARGIN, (height / boardHeight) * FIT_MARGIN))
  return {
    scale,
    x: (width - boardWidth * scale) / 2 - minX * scale,
    y: (height - boardHeight * scale) / 2 - minY * scale,
  }
}

export function ShareViewer({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const board = await apiRequest(shareBoardJsonPath(token), {
          schema: SharedBoardSchema,
          // A share is anonymous by definition. Sending credentials would
          // attach the viewer's OWN admin cookie (if they happen to have one
          // for this origin) to a public request for no reason.
          credentials: 'omit',
        })
        if (cancelled) return
        setState({ status: 'ready', board })
      } catch (err) {
        if (cancelled) return
        // Every failure is the same failure to a viewer — see
        // `ShareUnavailable`. Logged, not surfaced: there is no operator here.
        if (!(err instanceof ApiError)) console.error('[share-viewer] could not load the shared board:', err)
        setState({ status: 'unavailable' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const fitToBoard = useCallback((board: SharedBoard) => {
    const element = surfaceRef.current
    if (!element) return
    setViewport(fitViewport(board, element.clientWidth, element.clientHeight))
  }, [])

  // Fit once the manifest has arrived and the surface has been measured.
  // `fitToBoard` is a dependency of this effect, which is the documented
  // exception to the no-manual-memoization rule.
  const board = state.status === 'ready' ? state.board : null
  useEffect(() => {
    if (board) fitToBoard(board)
  }, [board, fitToBoard])

  if (state.status === 'loading') {
    return <div className={styles.loading} role="status" aria-label="Loading the shared board" />
  }
  if (state.status === 'unavailable') return <ShareUnavailable />

  const shared = state.board

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const element = surfaceRef.current
    if (!element) return
    if (event.ctrlKey || event.metaKey) {
      const rect = element.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      setViewport((current) => {
        const next = clampScale(current.scale * Math.exp(-event.deltaY / 320))
        const ratio = next / current.scale
        return {
          scale: next,
          // Keep the board point under the cursor fixed while zooming.
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        }
      })
      return
    }
    setViewport((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
  }

  function zoomBy(factor: number) {
    const element = surfaceRef.current
    if (!element) return
    const centreX = element.clientWidth / 2
    const centreY = element.clientHeight / 2
    setViewport((current) => {
      const next = clampScale(current.scale * factor)
      const ratio = next / current.scale
      return {
        scale: next,
        x: centreX - (centreX - current.x) * ratio,
        y: centreY - (centreY - current.y) * ratio,
      }
    })
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Primary button (or touch/pen) only — a right-click is the browser's.
    if (event.button !== 0) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    setViewport((current) => ({
      ...current,
      x: pan.originX + (event.clientX - pan.startX),
      y: pan.originY + (event.clientY - pan.startY),
    }))
  }

  function endPan(event: React.PointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div className={styles.viewer}>
      <header className={styles.header}>
        <span className={styles.projectName}>{shared.projectName}</span>
        <span className={styles.boardName}>{shared.boardName}</span>
        <span className={styles.snapshotNote}>
          {/* A share is a snapshot by design in v1, and saying so is part of
              the feature: a reviewer who assumes it is live will review the
              wrong thing. */}
          Snapshot of {formatSharedAt(shared.sharedAt)}
        </span>
      </header>

      <div
        ref={surfaceRef}
        className={styles.surface}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className={styles.board}
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          {shared.frames.map((frame) => (
            <figure
              key={frame.image}
              className={styles.frame}
              style={{ left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.width}px`, height: `${frame.height}px` }}
            >
              <figcaption className={styles.frameName}>{frame.name}</figcaption>
              <img
                className={styles.frameImage}
                src={shareFrameImagePath(token, frame.image)}
                alt={frame.name}
                draggable={false}
              />
            </figure>
          ))}
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.zoomControls}>
          <Button variant="ghost" size="xs" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
            −
          </Button>
          <span className={styles.zoomLevel}>{Math.round(viewport.scale * 100)}%</span>
          <Button variant="ghost" size="xs" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
            +
          </Button>
          <Button variant="ghost" size="xs" onClick={() => fitToBoard(shared)}>
            Fit
          </Button>
        </div>
        <span className={styles.madeIn}>Made in Studio</span>
      </footer>
    </div>
  )
}

/**
 * A snapshot timestamp in the viewer's own locale. Falls back to the raw ISO
 * string rather than throwing if the stored value is not a date this browser
 * can parse — a manifest is a file on disk and may have been hand-edited.
 */
function formatSharedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
