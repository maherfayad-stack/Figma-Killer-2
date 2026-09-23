/**
 * usePrototypeEndpoints — where each connector's ends are, in BOARD space.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT
 * ─────────────────────────────────
 * A frame's board rect is STORE DATA (`BoardFrame.x/y/width/height`). Nothing
 * about it needs the DOM, so moving or resizing a frame is a plain re-render
 * with no measurement at all.
 *
 * The only thing that genuinely needs measuring is where an element sits INSIDE
 * its frame, and that changes for exactly one reason: the page's content
 * reflowed. So the measurement is event-driven — a frame announcing that it
 * mounted, resized or swapped its module graph, the set of mounted frames
 * changing, or the page tree itself changing under an edit — and above all
 * nothing on pan or zoom, which cannot move a board-space endpoint because
 * `CanvasTransformLayer` moves the whole layer for free. Measuring per
 * animation frame instead would round-trip every mounted frame on every wheel
 * tick, which is how this feature becomes a stutter machine.
 *
 * An element's rect inside its frame is frame-local and UNSCALED: the canvas
 * transform scales the `<iframe>` ELEMENT, not the CSS pixels of the document
 * inside it. That is why none of this needs the canvas root's rect or the live
 * transform ref, and why composing `frame origin + element rect` is the whole
 * conversion.
 *
 * WHY THIS GOES THROUGH THE FRAME ADAPTER (`live-20`)
 * ──────────────────────────────────────────────────
 * Every board frame is a Tier 2 live frame by default — a cross-origin iframe
 * whose document the parent cannot read. The old version of this hook read
 * `iframe.contentDocument` directly, which is structurally `null` there, so
 * the `+` handle simply never appeared on a live board and the feature looked
 * deleted. `FrameDocumentAdapter.measure` is the one measurement API that
 * works identically for a same-origin portal frame and a bridge frame (a
 * `postMessage` round trip with the rect measured by the frame's own
 * runtime), and it is what the selection toolbar's anchor and the Inspect
 * panel already use — a second opinion about where a node is means the `+`
 * handle and the selection ring disagree about which things exist.
 */
import { useEffect, useState } from 'react'
import { FRAME_HEIGHT, FRAME_WIDTH, type BoardFrame } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import type { FrameDocumentAdapter, Unsubscribe } from '../frameAdapter/FrameDocumentAdapter'
import { listFrameAdapters, onFrameAdapterRegistryChange } from '../frameAdapter/canvasFrameAdapterRegistry'
import type { BoardRect } from './connectorGeometry'

export function frameBoardRect(frame: BoardFrame): BoardRect {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width ?? FRAME_WIDTH,
    height: frame.height ?? FRAME_HEIGHT,
  }
}

/** Compose a frame-local rect with its frame's board position. */
export function toBoardRect(frameRect: BoardRect, local: BoardRect): BoardRect {
  return { x: frameRect.x + local.x, y: frameRect.y + local.y, width: local.width, height: local.height }
}

/**
 * Frame-local rects for `nodeIds`, remeasured whenever one of their frames
 * reflows.
 *
 * Every mounted frame is asked at once and the FIRST frame that renders a
 * node answers for it — a link belongs to the page, and `BoardPrototypeLayer`
 * draws it from the first frame of that page for the same reason. A frame
 * that does not render the node reports a `null` rect and is skipped; a frame
 * whose runtime is not up yet times out and is skipped the same way, and its
 * own `ready` event re-runs the pass.
 */
export function useNodeFrameRects(nodeIds: readonly string[]): ReadonlyMap<string, BoardRect> {
  const [rects, setRects] = useState<ReadonlyMap<string, BoardRect>>(EMPTY_RECTS)
  // Join on a stable primitive: `nodeIds` is a fresh array on every render, so
  // depending on it directly would tear down and rebuild the subscriptions
  // forever.
  const key = nodeIds.join('|')

  useEffect(() => {
    const ids = key.length > 0 ? key.split('|') : []
    // Nothing to watch: leave the last map in place rather than clearing it.
    // Every read is `get(id)` for an id the caller wants RIGHT NOW, so a stale
    // entry is unreachable, and clearing here would mean writing state
    // synchronously inside an effect body for no observable difference.
    if (ids.length === 0) return

    const refs = ids.map((nodeId) => ({ nodeId }))
    let disposed = false
    // A pass that resolves after a newer one started is stale: the frame set
    // or the layout it measured has already moved on.
    let generation = 0

    const measure = () => {
      const pass = ++generation
      const adapters = [...listFrameAdapters().values()]
      void Promise.all(adapters.map((adapter) => measureQuietly(adapter, refs))).then((perFrame) => {
        if (disposed || pass !== generation) return
        const next = new Map<string, BoardRect>()
        for (const measurements of perFrame) {
          for (const { nodeId, rect } of measurements) {
            if (rect && !next.has(nodeId)) next.set(nodeId, rect)
          }
        }
        setRects((previous) => (sameRects(previous, next) ? previous : next))
      })
    }

    // A store edit reflows the page AFTER the store notifies (React commits
    // the portal frame, the bridge frame applies its optimistic op), so the
    // pass waits one macrotask rather than measuring the layout it is about
    // to invalidate. Coalesced: a burst of edits schedules one pass.
    let pending: ReturnType<typeof setTimeout> | null = null
    const measureSoon = () => {
      if (pending !== null) return
      pending = setTimeout(() => {
        pending = null
        measure()
      }, 0)
    }

    let frameEvents: Unsubscribe[] = []
    const subscribeToFrames = () => {
      for (const unsubscribe of frameEvents) unsubscribe()
      frameEvents = []
      for (const adapter of listFrameAdapters().values()) {
        frameEvents.push(
          adapter.on('ready', measureSoon),
          adapter.on('frame:resize', measureSoon),
          adapter.on('hmr:after', measureSoon),
        )
      }
    }

    subscribeToFrames()
    measureSoon()
    const unsubscribeRegistry = onFrameAdapterRegistryChange(() => {
      subscribeToFrames()
      measureSoon()
    })
    const unsubscribeStore = useEditorStore.subscribe((state, previous) => {
      if (state.site?.pages !== previous.site?.pages) measureSoon()
    })

    return () => {
      disposed = true
      if (pending !== null) clearTimeout(pending)
      unsubscribeRegistry()
      unsubscribeStore()
      for (const unsubscribe of frameEvents) unsubscribe()
    }
  }, [key])

  return rects
}

/**
 * One frame's answer, or nothing. A bridge frame whose runtime is not up yet
 * rejects with a timeout; that is "this frame has no answer right now", not
 * an error the pass should surface, and its `ready` event re-runs the pass.
 */
async function measureQuietly(
  adapter: FrameDocumentAdapter,
  refs: { nodeId: string }[],
): Promise<Awaited<ReturnType<FrameDocumentAdapter['measure']>>> {
  try {
    return await adapter.measure(refs)
  } catch (_err) {
    // A measurement timeout on a frame that is still booting; see above.
    return []
  }
}

const EMPTY_RECTS: ReadonlyMap<string, BoardRect> = new Map()

function sameRect(a: BoardRect, b: BoardRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Value equality, so a remeasure that found nothing new re-renders nothing. */
function sameRects(a: ReadonlyMap<string, BoardRect>, b: ReadonlyMap<string, BoardRect>): boolean {
  if (a.size !== b.size) return false
  for (const [id, rect] of a) {
    const other = b.get(id)
    if (!other || !sameRect(rect, other)) return false
  }
  return true
}
