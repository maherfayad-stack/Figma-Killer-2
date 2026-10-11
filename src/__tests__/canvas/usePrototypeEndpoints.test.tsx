/**
 * useNodeFrameRects — the prototype layer's "where is this element inside its
 * frame" measurement, through the frame adapter registry (`live-20`).
 *
 * The bug this guards: every board frame is a Tier 2 live frame by default,
 * whose document the parent cannot read. The old hook read
 * `iframe.contentDocument` directly, got `null`, and the `+` link handle
 * never rendered — the feature looked deleted. These fixtures are adapters
 * with NO reachable document at all (exactly a bridge frame's shape), so a
 * regression back to a document reach-in fails every case here.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import type {
  FrameDocumentAdapter,
  FrameRuntimeEvent,
  NodeMeasurement,
  Unsubscribe,
} from '@site/canvas/frameAdapter/FrameDocumentAdapter'
import {
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { useNodeFrameRects } from '@site/canvas/BoardPrototypeLayer/usePrototypeEndpoints'
import type { BoardRect } from '@site/canvas/BoardPrototypeLayer/connectorGeometry'

type Handler = (event: FrameRuntimeEvent) => void

interface StubFrame {
  iframe: HTMLIFrameElement
  adapter: FrameDocumentAdapter
  /** What the next `measure` answers, per node id; absent = `rect: null`. */
  rects: Map<string, BoardRect>
  /** Every `measure` call's node ids, in order. */
  calls: string[][]
  fire(event: FrameRuntimeEvent): void
  /** Makes every `measure` reject, the way a bridge frame that is not up yet times out. */
  failing: boolean
}

const mounted: StubFrame[] = []

function mountStubFrame(rects: Record<string, BoardRect> = {}): StubFrame {
  const handlers = new Map<string, Set<Handler>>()
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const frame: StubFrame = {
    iframe,
    rects: new Map(Object.entries(rects)),
    calls: [],
    failing: false,
    fire(event) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
    adapter: {
      applyOverlay: () => {},
      removeOverlay: () => {},
      select: () => {},
      hover: () => {},
      measure: async (refs): Promise<NodeMeasurement[]> => {
        frame.calls.push(refs.map((ref) => ref.nodeId))
        if (frame.failing) throw new Error('measure timed out')
        return refs.map(({ nodeId }) => ({
          nodeId,
          rect: frame.rects.get(nodeId) ?? null,
          computedStyle: {},
        }))
      },
      measureDropCandidates: async () => [],
      setAxes: () => {},
      setInteractionMode: () => {},
      optimistic: { insert: () => {}, delete: () => {}, move: () => {} },
      on: (event, handler): Unsubscribe => {
        const set = handlers.get(event) ?? new Set<Handler>()
        handlers.set(event, set)
        set.add(handler as Handler)
        return () => set.delete(handler as Handler)
      },
      dispose: () => {},
    },
  }
  registerFrameAdapter(iframe, frame.adapter, 'desktop')
  mounted.push(frame)
  return frame
}

let latest: ReadonlyMap<string, BoardRect> = new Map()

function Probe({ ids }: { ids: readonly string[] }) {
  const rects = useNodeFrameRects(ids)
  // Reported from an effect, not during render: the probe is observed by the
  // test after `settle()`, which always runs past the commit.
  useEffect(() => {
    latest = rects
  }, [rects])
  return <span data-testid="count">{rects.size}</span>
}

/** Lets the hook's deferred pass (one macrotask) and its promise settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

afterEach(() => {
  cleanup()
  for (const frame of mounted.splice(0)) {
    unregisterFrameAdapter(frame.iframe)
    frame.iframe.remove()
  }
  latest = new Map()
})

const RECT_A: BoardRect = { x: 10, y: 20, width: 100, height: 40 }
const RECT_B: BoardRect = { x: 30, y: 60, width: 50, height: 50 }

describe('useNodeFrameRects — through the frame adapter, never a document reach-in', () => {
  it('reports the rect a frame with no reachable document measured for the node', async () => {
    mountStubFrame({ a: RECT_A })
    render(<Probe ids={['a']} />)
    await settle()

    expect(latest.get('a')).toEqual(RECT_A)
  })

  it('leaves out a node no mounted frame renders, and one a frame answered null for', async () => {
    mountStubFrame({ a: RECT_A })
    render(<Probe ids={['a', 'missing']} />)
    await settle()

    expect(latest.has('missing')).toBe(false)
    expect(latest.size).toBe(1)
  })

  it('takes the FIRST frame that renders a node, in registration order', async () => {
    mountStubFrame({ a: RECT_A })
    mountStubFrame({ a: RECT_B })
    render(<Probe ids={['a']} />)
    await settle()

    expect(latest.get('a')).toEqual(RECT_A)
  })

  it('asks every mounted frame in one pass, all ids at once', async () => {
    const first = mountStubFrame()
    const second = mountStubFrame()
    render(<Probe ids={['a', 'b']} />)
    await settle()

    expect(first.calls).toEqual([['a', 'b']])
    expect(second.calls).toEqual([['a', 'b']])
  })

  it('remeasures when a frame reports a reflow (frame:resize, hmr:after, ready)', async () => {
    const frame = mountStubFrame({ a: RECT_A })
    render(<Probe ids={['a']} />)
    await settle()
    expect(latest.get('a')).toEqual(RECT_A)

    frame.rects.set('a', RECT_B)
    frame.fire({ type: 'frame:resize', height: 900 })
    await settle()
    expect(latest.get('a')).toEqual(RECT_B)

    frame.rects.set('a', RECT_A)
    frame.fire({ type: 'hmr:after' })
    await settle()
    expect(latest.get('a')).toEqual(RECT_A)

    frame.rects.set('a', RECT_B)
    frame.fire({ type: 'ready' })
    await settle()
    expect(latest.get('a')).toEqual(RECT_B)
  })

  it('picks up a frame that mounts after the hook did', async () => {
    render(<Probe ids={['a']} />)
    await settle()
    expect(latest.has('a')).toBe(false)

    const late = mountStubFrame({ a: RECT_A })
    await settle()
    expect(latest.get('a')).toEqual(RECT_A)

    // And subscribes to the newcomer's own reflow events.
    late.rects.set('a', RECT_B)
    late.fire({ type: 'frame:resize', height: 500 })
    await settle()
    expect(latest.get('a')).toEqual(RECT_B)
  })

  it('a frame whose measurement times out is skipped, not fatal for the others', async () => {
    const booting = mountStubFrame()
    booting.failing = true
    mountStubFrame({ a: RECT_A })
    render(<Probe ids={['a']} />)
    await settle()

    expect(latest.get('a')).toEqual(RECT_A)
  })

  it('a remeasure that finds nothing new keeps the same map identity', async () => {
    const frame = mountStubFrame({ a: RECT_A })
    render(<Probe ids={['a']} />)
    await settle()
    const before = latest

    frame.fire({ type: 'frame:resize', height: 700 })
    await settle()
    expect(latest).toBe(before)
  })

  it('does not measure at all for an empty id list', async () => {
    const frame = mountStubFrame({ a: RECT_A })
    render(<Probe ids={[]} />)
    await settle()

    expect(frame.calls).toEqual([])
  })

  it('stops listening once unmounted', async () => {
    const frame = mountStubFrame({ a: RECT_A })
    const { unmount } = render(<Probe ids={['a']} />)
    await settle()
    expect(frame.calls).toHaveLength(1)

    unmount()
    frame.fire({ type: 'frame:resize', height: 100 })
    await settle()
    expect(frame.calls).toHaveLength(1)
  })
})
