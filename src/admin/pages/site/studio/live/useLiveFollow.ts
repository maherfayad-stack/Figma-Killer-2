/**
 * useLiveFollow - both halves of follow mode.
 *
 * Publishing: while somebody follows this tab (the server says so with
 * `followed-by`), the visible board rectangle goes out at 10 Hz, read off the
 * DOM transform because the store's pan/zoom lags a gesture by ~100 ms.
 *
 * Following: the target's viewport is framed in this tab's own canvas. Any pan
 * or zoom this tab makes itself - a wheel over the canvas, or a transform the
 * store receives that following did not write - ends following.
 */
import { useEffect } from 'react'
import { LIVE_VIEWPORT_SEND_MS, transformToFollow, visibleBoardRect, type LiveViewport } from '@core/studio-live'
import { useEditorStore } from '@site/store/store'
import { canvasZoomOf } from '../../canvas/canvasZoom'
import { clampZoom } from '../../canvas/math'
import { findCanvasRoot, findTransformLayer } from './liveBoardPoint'
import { useLivePresence } from './livePresenceStore'
import { getLiveClient } from './studioLiveConnection'

function sameViewport(a: LiveViewport | null, b: LiveViewport): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.zoom === b.zoom
}

/** The board rectangle this tab shows right now, from the DOM. */
function readOwnViewport(): LiveViewport | null {
  const layer = findTransformLayer()
  const root = findCanvasRoot()
  if (!layer || !root) return null
  const zoom = canvasZoomOf(layer)
  const layerRect = layer.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  if (rootRect.width <= 0 || rootRect.height <= 0) return null
  // layerRect.left - rootRect.left = inset + pan, so with the inset known
  // (offsetLeft) the pan falls out and `visibleBoardRect` does the rest.
  return visibleBoardRect(
    { rootWidth: rootRect.width, rootHeight: rootRect.height, offsetX: layer.offsetLeft, offsetY: layer.offsetTop },
    { zoom, panX: layerRect.left - rootRect.left - layer.offsetLeft, panY: layerRect.top - rootRect.top - layer.offsetTop },
  )
}

export function useLiveFollow(): void {
  const followedByCount = useLivePresence((s) => s.followedByCount)
  const status = useLivePresence((s) => s.status)

  // Publishing, only while followed.
  useEffect(() => {
    if (status !== 'live' || followedByCount === 0) return
    let last: LiveViewport | null = null
    const send = (): void => {
      const viewport = readOwnViewport()
      if (!viewport || sameViewport(last, viewport)) return
      last = viewport
      getLiveClient()?.sendPresence({ viewport })
    }
    send()
    const timer = setInterval(send, LIVE_VIEWPORT_SEND_MS)
    return () => clearInterval(timer)
  }, [status, followedByCount])

  // Following.
  useEffect(() => {
    let applied: readonly [number, number, number] | null = null

    function stopFollowing(): void {
      if (useLivePresence.getState().followingId === null) return
      useLivePresence.getState().setFollowing(null)
      getLiveClient()?.follow(null)
    }

    function applyTargetViewport(viewport: LiveViewport | null): void {
      if (!viewport) return
      const layer = findTransformLayer()
      const root = findCanvasRoot()
      if (!layer || !root) return
      const rootRect = root.getBoundingClientRect()
      const next = transformToFollow(
        viewport,
        { rootWidth: rootRect.width, rootHeight: rootRect.height, offsetX: layer.offsetLeft, offsetY: layer.offsetTop },
        clampZoom,
      )
      if (!next) return
      applied = [next.zoom, next.panX, next.panY]
      useEditorStore.getState().setCanvasTransform(next.zoom, next.panX, next.panY)
    }

    const unsubscribePresence = useLivePresence.subscribe((state, previous) => {
      const id = state.followingId
      if (!id) return
      const viewport = state.presence[id]?.viewport ?? null
      if (viewport && viewport !== previous.presence[id]?.viewport) applyTargetViewport(viewport)
    })

    // A transform the store receives that following did not write is the user.
    const unsubscribeTransform = useEditorStore.subscribe((state, previous) => {
      if (state.zoom === previous.zoom && state.panX === previous.panX && state.panY === previous.panY) return
      if (useLivePresence.getState().followingId === null) return
      const own = applied
      const isOurs = own !== null && state.zoom === own[0] && state.panX === own[1] && state.panY === own[2]
      if (!isOurs) stopFollowing()
    })

    // On the window, not the root: the canvas mounts after this hook does.
    function onWheel(event: WheelEvent): void {
      if (event.target instanceof Node && findCanvasRoot()?.contains(event.target)) stopFollowing()
    }
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })

    return () => {
      unsubscribePresence()
      unsubscribeTransform()
      window.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [])
}

/** Starts (or, on the same member, stops) following; tells the server. */
export function toggleFollow(memberId: string): void {
  const current = useLivePresence.getState().followingId
  const next = current === memberId ? null : memberId
  useLivePresence.getState().setFollowing(next)
  getLiveClient()?.follow(next)
}
