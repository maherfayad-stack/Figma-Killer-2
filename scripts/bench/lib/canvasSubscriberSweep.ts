/**
 * The canvas subscriber sweep — what ONE editor-store `set()` costs once the
 * canvas's per-node selectors are mounted (audit `01-perf.md` §1, budget 1).
 *
 * Zustand re-runs every subscriber's selector on every store set. The canvas
 * mounts one `NodeRenderer` per node per mounted frame, and each of those
 * subscribes the selectors below. So the hottest editor events — a click, a
 * keystroke, a pan commit — pay `frames × nodes × selectors` runs of pure JS
 * before React starts. A hover crossing used to as well; since P2-I it is not
 * a store write at all (`canvas/canvasHover.ts`). The
 * zero-subscriber scenarios in `editor-store.ts` structurally cannot see
 * that cost, and on the committed 12 × 28 perf fixture it is ~0.5 ms, which
 * no e2e budget can see either. This measures it on a board the size the
 * audit named: 40 pages × 300 nodes, 12 mounted frames.
 *
 * ## The selectors are a MIRROR, and must stay one
 *
 * The `selectors` list in `runCanvasSubscriberSweep` copies `NodeRenderer.tsx`'s seven
 * `useEditorStore(...)` reads (node, isInlineEditing, the two preview reads,
 * two form-preview reads, the class-name build). Each node also registers the
 * KEYED selection read `useIsNodeSelected` makes (`canvasNodeSelection.ts`),
 * which is one store listener for the whole canvas, not one per node, and
 * hover is driven through `canvasHover.ts`, exactly as the canvas drives it.
 * `per-node-selector-budget.test.ts` counts that component's subscriptions;
 * when that count changes, this list changes in the same PR. A mirror that
 * drifts measures a component that no longer exists.
 *
 * No React and no DOM: it measures selector work only, which is the floor.
 */
import { performance } from 'node:perf_hooks'
import { summarize, type LatencySummary } from './stats'

/**
 * Per-scenario median budgets, in ms, for the full-size sweep (40 × 300 × 12).
 *
 * Calibrated on the first committed run (P2-A, 2026-09-23, this Windows box,
 * Bun/JSC — numbers in the P2-A `STATE.md` entry and PR body) at about 1.5×
 * the observed median, so a real regression fails and machine noise does not.
 * They are a RATCHET on today's selector shape, not the target: P2-I moves
 * hover off the global store and replaces the two `useShallow` selectors,
 * and its exit gate is `hoverEdge` under 1.5 ms (`01-perf.md` §3 item 1).
 * Tighten these in that PR — never loosen them to make a run pass.
 *
 * `annotationMarqueeNoop` is the exception: it is a no-op by construction
 * after PERF-11 (the marquee writes the same annotation selection on every
 * pointermove), so its budget is "the guard returned before `set()`".
 */
export const SUBSCRIBER_SWEEP_BUDGETS_MS = {
  /** Observed medians 16.1 / 9.5 / 11.0 ms (loaded machine; the audit's quieter run read 6.4). */
  hoverEdge: 24,
  /** `hoverNode`'s same-value guard (`speed-03`) returns before `set()`: observed 0.000-0.001 ms. */
  hoverNoop: 0.5,
  /** Observed 22.3 / 24.4 / 22.5 ms. */
  selectNode: 36,
  /** Observed 23.5 / 25.3 / 25.3 ms. */
  keystroke: 38,
  /** Observed 15.6 / 17.9 / 16.0 ms. */
  panCommit: 27,
  /** Observed 20.9 / 23.3 / 22.5 ms BEFORE the PERF-11 guard — a full sweep for a no-op. */
  annotationMarqueeNoop: 0.5,
} as const

export type SubscriberSweepScenario = keyof typeof SUBSCRIBER_SWEEP_BUDGETS_MS

export interface SubscriberSweepShape {
  pages: number
  nodesPerPage: number
  mountedFrames: number
  iterations: number
}

export const FULL_SWEEP_SHAPE: SubscriberSweepShape = { pages: 40, nodesPerPage: 300, mountedFrames: 12, iterations: 200 }

export interface SubscriberSweepResult {
  shape: SubscriberSweepShape
  subscribers: number
  scenarios: Record<SubscriberSweepScenario, LatencySummary>
}

interface SweepNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  breakpointOverrides: Record<string, unknown>
  children: string[]
  classIds: string[]
}

/** Same BFS shape `editor-store.ts`'s `buildStorePage` builds: 4 children per parent, two containers + two texts. */
function buildSweepPage(prefix: string, target: number) {
  const nodes: Record<string, SweepNode> = {}
  const rootId = `${prefix}-n0`
  nodes[rootId] = { id: rootId, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] }
  let counter = 1
  const queue = [rootId]
  while (counter < target && queue.length > 0) {
    const parentId = queue.shift()!
    const kids: string[] = []
    for (let i = 0; i < Math.min(4, target - counter); i++) {
      const id = `${prefix}-n${counter++}`
      const isContainer = i < 2
      nodes[id] = {
        id,
        moduleId: isContainer ? 'base.container' : 'base.text',
        props: isContainer ? { tag: 'div' } : { text: `node ${id}`, tag: 'p' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      }
      if (isContainer) queue.push(id)
      kids.push(id)
    }
    nodes[parentId].children = kids
  }
  return { id: `${prefix}-page`, slug: prefix === 'sw0' ? 'index' : prefix, title: prefix, nodes, rootNodeId: rootId }
}

/**
 * Runs the sweep against the LIVE editor store (`src/admin/pages/site/store`).
 * Leaves the store loaded with the synthetic site; the caller resets it.
 */
export async function runCanvasSubscriberSweep(shape: SubscriberSweepShape): Promise<SubscriberSweepResult> {
  await import('../../../src/modules/base')
  const { useEditorStore, selectCanvasPageFor } = await import('../../../src/admin/pages/site/store/store')
  const { getCanvasNodeClassName } = await import('../../../src/admin/pages/site/canvas/canvasNodeClassName')
  const { resolveEditorFormPreviewState, resolveEditorFormPreviewSuccessMessage } = await import(
    '../../../src/admin/pages/site/canvas/canvasFormPreview'
  )
  const { isInlineEditSessionFor } = await import('../../../src/admin/pages/site/store/slices/inlineEditSlice')
  const { subscribeNodeSelection } = await import('../../../src/admin/pages/site/canvas/canvasNodeSelection')
  const { clearCanvasHover, setCanvasHover } = await import('../../../src/admin/pages/site/canvas/canvasHover')
  type S = ReturnType<typeof useEditorStore.getState>

  useEditorStore.setState({ site: null, _historyPast: [], _historyFuture: [], selectedNodeIds: [], selectedNodeId: null })
  clearCanvasHover()
  useEditorStore.getState().createSite('Sweep')
  const base = useEditorStore.getState().site
  if (!base) throw new Error('createSite produced no site — update canvasSubscriberSweep.')
  const site = structuredClone(base) as unknown as { pages: ReturnType<typeof buildSweepPage>[] }
  site.pages = Array.from({ length: shape.pages }, (_, i) => buildSweepPage(`sw${i}`, shape.nodesPerPage))
  useEditorStore.getState().loadSite(site as unknown as Parameters<S['loadSite']>[0])

  const BREAKPOINT = 'studio'
  type Selector = [(s: S) => unknown, (a: unknown, b: unknown) => boolean]
  const unsubs: Array<() => void> = []
  for (let frame = 0; frame < shape.mountedFrames; frame++) {
    const page = site.pages[frame]
    const pageId = page.id
    const frameId = `frame-${frame}`
    for (const nodeId of Object.keys(page.nodes)) {
      const selectors: Selector[] = [
        [(s) => selectCanvasPageFor(s, pageId, frameId)?.nodes[nodeId] ?? null, Object.is],
        [(s) => isInlineEditSessionFor(s.activeInlineEdit, nodeId, BREAKPOINT, frameId), Object.is],
        [(s) => (s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null), Object.is],
        [(s) => (s.previewNodeStyles?.nodeIds.includes(nodeId) ? s.previewNodeStyles : null), Object.is],
        [(s) => resolveEditorFormPreviewState(s, nodeId), Object.is],
        [(s) => resolveEditorFormPreviewSuccessMessage(s, nodeId), Object.is],
        [
          (s) => {
            const canvasNode = selectCanvasPageFor(s, pageId, frameId)?.nodes[nodeId]
            const preview = s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null
            return getCanvasNodeClassName(canvasNode?.classIds, preview, nodeId, s.site?.styleRules)
          },
          Object.is,
        ],
      ]
      for (const [selector, equalityFn] of selectors) {
        unsubs.push(useEditorStore.subscribe(selector, () => {}, { equalityFn }))
      }
      // `useIsNodeSelected` — keyed: a listener per node, no selector run per `set()`.
      unsubs.push(subscribeNodeSelection(nodeId, () => {}))
    }
  }

  const time = (run: (i: number) => void, iterations = shape.iterations): LatencySummary => {
    for (let i = 0; i < 20; i++) run(i) // warm-up: JIT + the first-set allocations
    const samples: number[] = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      run(i)
      samples.push(performance.now() - t0)
    }
    return summarize(samples)
  }

  try {
    const ids = Object.keys(site.pages[0].nodes)
    const store = () => useEditorStore.getState()
    const hoverEdge = time((i) => setCanvasHover(i % 2 ? ids[i % ids.length]! : null, BREAKPOINT, 'frame-0'))
    setCanvasHover(ids[3]!, BREAKPOINT, 'frame-0')
    const hoverNoop = time(() => setCanvasHover(ids[3]!, BREAKPOINT, 'frame-0'))
    clearCanvasHover()
    const selectNode = time((i) => store().selectNode(ids[(i * 7) % ids.length], 'replace', { frameId: 'frame-0' }))
    store().setActivePage(site.pages[0].id)
    const keystroke = time((i) => store().updateNodeProps(ids[5], { text: `v${i}` }), Math.max(20, shape.iterations >> 1))
    const panCommit = time((i) => store().setCanvasTransform(1, i, i))
    // The marquee writes the SAME annotation hit set on every pointermove
    // while the rectangle grows over empty board (`useMarqueeSelection.ts`).
    store().setSelectedAnnotations([])
    const annotationMarqueeNoop = time(() => store().setSelectedAnnotations([]))
    return {
      shape,
      subscribers: unsubs.length,
      scenarios: { hoverEdge, hoverNoop, selectNode, keystroke, panCommit, annotationMarqueeNoop },
    }
  } finally {
    for (const unsub of unsubs) unsub()
  }
}

/** Scenarios whose median exceeds its budget. Empty when the sweep is within budget. */
export function subscriberSweepBreaches(result: SubscriberSweepResult): string[] {
  const breaches: string[] = []
  for (const [scenario, budget] of Object.entries(SUBSCRIBER_SWEEP_BUDGETS_MS) as Array<[SubscriberSweepScenario, number]>) {
    const median = result.scenarios[scenario].p50
    if (median > budget) breaches.push(`${scenario}: median ${median.toFixed(2)} ms > budget ${budget} ms`)
  }
  return breaches
}
