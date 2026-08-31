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

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

/** A canvas breakpoint frame with one styled node, plus a spy counting the
 *  cross-document `[data-node-id]` queries made against its document. */
function setUpCanvasFrame(nodeId: string, breakpointId = 'bp-desktop') {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument!
  frameDoc.body.setAttribute('data-breakpoint-id', breakpointId)

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

    expect(result.current).toEqual({ color: 'red', width: '100px' })
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
    expect(result.current?.color).toBe('red')
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
    expect(result.current?.color).toBe('blue')
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

    expect(second).toBe(first)
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

    expect(second).not.toBe(first)
    expect(second).toEqual({ color: 'blue', width: '100px' })
  })

  it('returns null, not a stale snapshot, once the node has no rendered element', () => {
    setUpCanvasFrame('n1')

    const { result, rerender } = renderHook(
      ({ nodeId }: { nodeId: string | null }) =>
        useFrameComputedStyleValues(nodeId, 'bp-desktop', ['color']),
      { initialProps: { nodeId: 'n1' as string | null } },
    )
    expect(result.current).not.toBeNull()

    rerender({ nodeId: null })
    expect(result.current).toBeNull()
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
    expect(first?.color).toBe('red')
    expect(queries()).toBe(1)

    // `node` object identity changing is what the real caller does on every
    // keystroke (see the hook's own doc) — the style on the canvas element
    // itself hasn't changed, so the snapshot should be the SAME reference.
    rerender({ node: { rev: 2 } })
    expect(result.current).toBe(first)
    expect(queries()).toBe(1)

    node.style.color = 'green'
    rerender({ node: { rev: 3 } })
    expect(result.current).not.toBe(first)
    expect(result.current?.color).toBe('green')
  })
})
