/**
 * useInspectComputedStyle / useFrameComputedStyleValues — the properties
 * panel's real `getComputedStyle` read.
 *
 * Perf-01: `StyleSurface` re-renders once per keystroke that edits the
 * selected node's style, and this hook used to redo an UNCACHED element
 * lookup (`document.querySelectorAll('iframe')` + a cross-document
 * `querySelector` per breakpoint frame) on every single one of those
 * re-renders. These tests prove, with call-count spies (no real browser
 * needed — see the task handoff for what still needs one):
 *
 *   1. The element lookup is cached across repeated renders for the SAME
 *      node — the cross-document `querySelector` inside the canvas frame's
 *      document runs once, not once per render.
 *   2. The returned snapshot/values object is REFERENTIALLY STABLE across
 *      renders where the underlying computed style hasn't changed — so a
 *      re-render triggered for an unrelated reason (not an edit to this
 *      node's own rendered style) doesn't hand every downstream consumer a
 *      new-but-identical object and cascade needless re-work through
 *      React Compiler's own auto-memoization.
 *   3. A REAL style change still produces a fresh, correct read — the cache
 *      never returns stale data.
 *
 * P5 (STATE.md `panel-26`): both hooks now return `{ value, isLoading }`.
 * Every test below asserts `isLoading: false` on top of its existing
 * assertions — this IS the "Tier 0/1 boards take zero new code paths" proof
 * the work order asked for, not a claim in prose: no test here ever
 * registers a `BridgeFrameAdapter`, only `PortalFrameAdapter`s, so
 * `hasBridgeFrameFor` is false for every one of them and the portal branch
 * (byte-identical internals — same cache, same `stabilizeRecord`, same
 * synchronous `getComputedStyle` read) is the only one ever exercised here.
 *
 * What this does NOT prove (needs a browser profile, not a unit test): the
 * millisecond cost of `getComputedStyle`'s own forced layout, or how many
 * fewer milliseconds a real keystroke now costs. `getComputedStyle` is
 * still called on every render that reaches it — see the hook's own doc for
 * why that's a deliberate, correctness-preserving choice, not an oversight.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { renderHook, cleanup } from '@testing-library/react'
import {
  useInspectComputedStyle,
  useFrameComputedStyleValues,
} from '@site/panels/InspectPanel/useInspectComputedStyle'
import { registerFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

let frameAdapters: PortalFrameAdapter[] = []

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  for (const adapter of frameAdapters) adapter.dispose()
  frameAdapters = []
})

/**
 * A canvas breakpoint frame with one styled node, plus a spy counting the
 * cross-document `[data-node-id]` queries made against its document.
 *
 * Registers a `PortalFrameAdapter` for the frame — since `live-05`
 * (STATE.md, the architect's Batch 4 resolution), both hooks under test
 * resolve elements only through registered frames
 * (`canvasFrameAdapterRegistry.ts`), not every iframe carrying
 * `data-breakpoint-id`.
 */
function setUpCanvasFrame(nodeId: string, breakpointId = 'bp-desktop') {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument!
  frameDoc.body.setAttribute('data-breakpoint-id', breakpointId)
  // The outer iframe element's own copy (P5, STATE.md `panel-26`) — not
  // exercised by the portal path under test here, but kept in sync with
  // production so a future test added to this file doesn't have to remember
  // to add it separately.
  frame.setAttribute('data-breakpoint-id', breakpointId)

  const node = frameDoc.createElement('div')
  node.setAttribute('data-node-id', nodeId)
  node.style.color = 'red'
  node.style.width = '100px'
  frameDoc.body.appendChild(node)

  let queries = 0
  const originalQuerySelector = frameDoc.querySelector.bind(frameDoc)
  // Cast through unknown — happy-dom's Document#querySelector overload set
  // isn't structurally identical to the DOM lib's, only spy-wrapping it.
  frameDoc.querySelector = ((selector: string) => {
    queries++
    return originalQuerySelector(selector)
  }) as typeof frameDoc.querySelector

  const adapter = new PortalFrameAdapter(frameDoc)
  frameAdapters.push(adapter)
  registerFrameAdapter(frame, adapter, 'desktop')

  return { frame, node, queries: () => queries }
}

describe('useFrameComputedStyleValues — element lookup caching', () => {
  it('resolves the element once and reuses it across repeated renders of the same node', () => {
    const { node, queries } = setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(
      ({ nodeId }: { nodeId: string }) =>
        useFrameComputedStyleValues(nodeId, 'bp-desktop', ['color', 'width']),
      { initialProps: { nodeId: 'n1' } },
    )

    expect(result.current.value).toEqual({ color: 'red', width: '100px' })
    expect(result.current.isLoading).toBe(false)
    expect(queries()).toBe(1)

    // Ten more renders of the SAME node — the old, uncached code path would
    // redo the cross-document element scan every time.
    for (let i = 0; i < 10; i++) rerender({ nodeId: 'n1' })

    expect(queries()).toBe(1)
    void node
  })

  it('self-heals when the node is unmounted and re-rendered as a different element', () => {
    const { frame, queries } = setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(() =>
      useFrameComputedStyleValues('n1', 'bp-desktop', ['color']),
    )
    expect(result.current.value?.color).toBe('red')
    expect(result.current.isLoading).toBe(false)
    expect(queries()).toBe(1)

    // A real re-render inside the canvas app: the old element is gone,
    // replaced by a new one (an unmount + remount, not an attribute tweak).
    const frameDoc = frame.contentDocument!
    frameDoc.body.innerHTML = ''
    const replacement = frameDoc.createElement('div')
    replacement.setAttribute('data-node-id', 'n1')
    replacement.style.color = 'blue'
    frameDoc.body.appendChild(replacement)

    rerender()
    expect(result.current.value?.color).toBe('blue')
    expect(result.current.isLoading).toBe(false)
  })
})

describe('useFrameComputedStyleValues — reference stability', () => {
  it('returns the SAME object across renders when the computed style has not changed', () => {
    setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(() =>
      useFrameComputedStyleValues('n1', 'bp-desktop', ['color', 'width']),
    )
    const first = result.current

    // Re-render for a reason unrelated to this node's rendered style (the
    // same thing happens in the real panel when e.g. the style search box
    // changes, or an unrelated store slice updates `StyleSurface`).
    rerender()
    const second = result.current

    expect(second.value).toBe(first.value)
    expect(second.isLoading).toBe(false)
  })

  it('returns a NEW object with the updated value when the style actually changed', () => {
    const { node } = setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(() =>
      useFrameComputedStyleValues('n1', 'bp-desktop', ['color', 'width']),
    )
    const first = result.current

    node.style.color = 'blue'
    rerender()
    const second = result.current

    expect(second.value).not.toBe(first.value)
    expect(second.value).toEqual({ color: 'blue', width: '100px' })
    expect(second.isLoading).toBe(false)
  })

  it('returns value: null, not a stale snapshot, once the node has no rendered element', () => {
    setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(
      ({ nodeId }: { nodeId: string | null }) =>
        useFrameComputedStyleValues(nodeId, 'bp-desktop', ['color']),
      { initialProps: { nodeId: 'n1' as string | null } },
    )
    expect(result.current.value).not.toBeNull()

    rerender({ nodeId: null })
    expect(result.current.value).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })
})

describe('useInspectComputedStyle — same caching + stability contract', () => {
  it('caches the element lookup and stabilizes the returned snapshot reference', () => {
    const { node, queries } = setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(
      ({ node: n }: { node: unknown }) => useInspectComputedStyle('n1', n, 'bp-desktop'),
      { initialProps: { node: { rev: 1 } } },
    )
    const first = result.current
    expect(first.value?.color).toBe('red')
    expect(first.isLoading).toBe(false)
    expect(queries()).toBe(1)

    // `node` object identity changing is what the real caller does on every
    // keystroke (see the hook's own doc) — the style on the canvas element
    // itself hasn't changed, so the snapshot should be the SAME reference.
    rerender({ node: { rev: 2 } })
    expect(result.current.value).toBe(first.value)
    expect(result.current.isLoading).toBe(false)
    expect(queries()).toBe(1)

    node.style.color = 'green'
    rerender({ node: { rev: 3 } })
    expect(result.current.value).not.toBe(first.value)
    expect(result.current.value?.color).toBe('green')
    expect(result.current.isLoading).toBe(false)
  })
})
