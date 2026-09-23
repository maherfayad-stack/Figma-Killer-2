/**
 * `speed-06` follow-up — a real Playwright dogfood on the primary stack
 * found the drop line into a live (Tier 2) frame always resolved "page
 * root", never a container, and a listener installed inside the frame saw
 * zero `dropCandidates` requests during the whole drag.
 *
 * Root cause: `IframeFrameSurface`'s bridge `<iframe>` carries its OWN copy
 * of `data-breakpoint-id` (so a caller holding only the `HTMLIFrameElement`
 * can read the breakpoint without a cross-origin `contentDocument` reach-in
 * — see that file's own doc), and `findCanvasViewportAtPoint` queried
 * `[data-breakpoint-id]` and returned whichever matched FIRST without
 * excluding the iframe itself. `viewport.querySelector('iframe')` — the
 * next step in `resolveCanvasPointerInsertionDrop` — finds nothing INSIDE
 * an `<iframe>` (no light-DOM children, cross-origin or not), so whenever
 * the match resolved to the iframe rather than its wrapper, `iframe` came
 * back `null`, `canvasInsertionDragSnapshot.ts`'s snapshot session took the
 * "no iframe" fallback (`measureCanvasDropCandidates(viewport, tree, null)`,
 * scanning the WRAPPER's own — empty, for a real frame — light DOM) on
 * EVERY resolve, and `adapter.measureDropCandidates()` — the only thing that
 * would ever post a `dropCandidates` request — was never reached at all.
 *
 * This test exercises the REAL registry + a REAL `BridgeFrameAdapter`
 * (constructed via `IframeFrameSurface`, not a hand-rolled stub) through
 * `resolveCanvasPointerInsertionDrop` — the same call `useCanvasInsertionDrag`
 * makes — so a regression in either `findCanvasViewportAtPoint`'s exclusion
 * or the snapshot session's iframe handling fails here first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { reindexNodeParents, type Page, type PageNode } from '@core/page-tree'
import { act, cleanup, render } from '@testing-library/react'
import { toOutboundEnvelope } from '@core/studio-runtime'
import { IframeFrameSurface } from '@site/canvas/IframeFrameSurface'
import { listFrameAdapters } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { beginInsertionDragSnapshotSession } from '@site/canvas/canvasInsertionDragSnapshot'
import { resolveCanvasPointerInsertionDrop, findCanvasViewportAtPoint } from '@site/canvas/canvasInsertionDrop'
import type { LiveFrameSource } from '@site/canvas/resolveLiveFrameSrc'
import '@modules/base/index'

// A sibling test file elsewhere in the suite can leave stray
// `[data-breakpoint-id]` elements in `document.body` if its own cleanup
// runs after this file's setup — `findCanvasViewportAtPoint` scans the
// WHOLE document, so both directions are guarded.
beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function node(id: string, moduleId: string, children: string[] = []): PageNode {
  return { id, moduleId, props: {}, breakpointOverrides: {}, children }
}
function page(nodes: Record<string, PageNode>, rootNodeId = 'root'): Page {
  reindexNodeParents(nodes)
  return { id: 'page', slug: 'index', title: 'Home', rootNodeId, nodes }
}
function domRect(init: { x: number; y: number; width: number; height: number }): DOMRect {
  return {
    x: init.x, y: init.y, left: init.x, top: init.y,
    right: init.x + init.width, bottom: init.y + init.height,
    width: init.width, height: init.height, toJSON: () => ({}),
  } as DOMRect
}

const FRAME_ORIGIN = 'https://live.studio.test'
function liveFrame(): LiveFrameSource {
  return { liveOrigin: FRAME_ORIGIN, screenKey: 'home', nodeIdsInTreeOrder: ['root', 'container'], axes: { direction: 'ltr', colorScheme: 'light' } }
}

/**
 * Mounts the SAME DOM shape `BreakpointFrame` + `IframeFrameSurface` (bridge
 * mode) produce: a wrapper `<div data-breakpoint-id>` containing a real,
 * adapter-backed `<iframe data-breakpoint-id>` — both stamped, exactly like
 * production. Rects are mocked (happy-dom has no layout engine); both
 * elements are given the IDENTICAL rect on purpose, so a resolver that fails
 * to exclude the iframe would still "successfully" match it.
 */
async function mountBridgeFrame(rect: { x: number; y: number; width: number; height: number }) {
  const wrapper = document.createElement('div')
  wrapper.dataset.breakpointId = 'mobile'
  wrapper.getBoundingClientRect = () => domRect(rect)
  document.body.appendChild(wrapper)

  render(
    <IframeFrameSurface breakpointId="mobile" width={rect.width} documentMode="bridge" liveFrame={liveFrame()}>
      <div />
    </IframeFrameSurface>,
    { container: wrapper },
  )
  await act(async () => {})

  const iframe = wrapper.querySelector('iframe')!
  iframe.getBoundingClientRect = () => domRect(rect)
  Object.defineProperty(iframe, 'offsetWidth', { value: rect.width, configurable: true })
  Object.defineProperty(wrapper, 'offsetWidth', { value: rect.width, configurable: true })

  return { wrapper, iframe }
}

/** Captures every `window.addEventListener('message', …)` listener installed while mounting, and the outbound posts the adapter makes on the iframe's own `contentWindow`. */
function spyOnBridgeChannel() {
  const handlers: Array<(ev: { origin: string; source: unknown; data: unknown }) => void> = []
  const original = window.addEventListener.bind(window)
  window.addEventListener = ((type: string, h: EventListenerOrEventListenerObject, ...rest: unknown[]) => {
    if (type === 'message') handlers.push(h as (ev: { origin: string; source: unknown; data: unknown }) => void)
    return (original as (...args: unknown[]) => void)(type, h, ...rest)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test spy signature
  }) as any
  return {
    handlers,
    restore: () => {
      window.addEventListener = original
    },
  }
}

describe('resolveCanvasPointerInsertionDrop — a live (bridge) frame stamped twice with data-breakpoint-id', () => {
  it('findCanvasViewportAtPoint never returns the bare iframe, even when both rects match identically', async () => {
    const { wrapper, iframe } = await mountBridgeFrame({ x: 0, y: 0, width: 200, height: 500 })

    const found = findCanvasViewportAtPoint(100, 100)
    expect(found).toBe(wrapper)
    expect(found).not.toBe(iframe)
  })

  it('a drag visiting a bridge surface issues exactly one dropCandidates request, and the resolver reports a container inside the frame — not the root', async () => {
    const spy = spyOnBridgeChannel()
    const { wrapper, iframe } = await mountBridgeFrame({ x: 0, y: 0, width: 200, height: 500 })

    const cw = iframe.contentWindow as unknown as { postMessage: (data: unknown, origin: string) => void }
    const posted: Array<{ message: { type: string; requestId?: string } }> = []
    const originalPost = cw.postMessage.bind(cw)
    cw.postMessage = (data: unknown, origin: string) => {
      posted.push(data as { message: { type: string; requestId?: string } })
      originalPost(data, origin)
    }

    // The frame says ready — `expectedSource` requires the REAL `contentWindow`.
    for (const h of spy.handlers) h({ origin: FRAME_ORIGIN, source: cw, data: toOutboundEnvelope({ type: 'ready' }) })
    await act(async () => {})

    expect(listFrameAdapters().has(iframe)).toBe(true)

    const tree = page({
      root: node('root', 'base.body', ['container']),
      container: node('container', 'base.container'),
    })
    const session = beginInsertionDragSnapshotSession()

    const resolveDrop = () =>
      resolveCanvasPointerInsertionDrop({
        canvasPage: tree,
        clientX: 100,
        clientY: 250,
        label: 'Drop AlmosaferLogo',
        candidatesForViewport: (viewport, iframeArg) => session.candidatesFor(viewport, iframeArg, tree),
      })

    // Move 1: the round trip is still in flight — same honest "page root"
    // answer a pointer outside every frame gets, never a hang.
    const firstResolve = resolveDrop()
    expect(firstResolve?.preview.label).toContain('at page root')

    const dropRequests = posted.filter((p) => p.message.type === 'dropCandidates')
    expect(dropRequests).toHaveLength(1)

    // Reply with a candidate matching `container`, sized so (100, 250) lands
    // inside it — body-relative coordinates, per `measureDropCandidates`'s
    // own contract.
    const requestId = dropRequests[0]!.message.requestId!
    for (const h of spy.handlers) {
      h({
        origin: FRAME_ORIGIN,
        source: cw,
        data: toOutboundEnvelope({
          type: 'dropCandidates:result',
          requestId,
          candidates: [
            { nodeId: 'container', occurrenceIndex: 0, rect: { x: 20, y: 20, width: 160, height: 400 }, axis: 'vertical', reversed: false, childRects: [] },
          ],
        }),
      })
    }
    await act(async () => {})
    await act(async () => {})

    // Move 2 (still over the same spot): the cache now has the real answer,
    // and no SECOND request goes out for the same frame.
    const secondResolve = resolveDrop()
    expect(secondResolve?.location.parentId).toBe('container')
    expect(secondResolve?.preview.label).not.toContain('page root')

    const dropRequestsAfter = posted.filter((p) => p.message.type === 'dropCandidates')
    expect(dropRequestsAfter).toHaveLength(1)

    session.dispose()
    spy.restore()
    void wrapper
  })
})
