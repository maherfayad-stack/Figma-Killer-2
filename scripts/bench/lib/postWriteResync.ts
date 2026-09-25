/**
 * Post-write re-sync — what ONE `patchPages` re-read costs the canvas
 * (audit `01-perf.md` PERF-6, missing budget 8).
 *
 * After every write the client re-reads the pages it touched and applies them
 * with `patchPages`, together with the server's full recompute of the style
 * registry. This counts, on a 40-page board with 12 mounted frames, what that
 * re-read makes the canvas do:
 *
 *  - `rerenders` — `NodeRenderer`s that re-render. `NodeRenderer` is a
 *    `memo()` over `nodeId` whose node is selected by identity, so it
 *    re-renders exactly when its id or its node object changed.
 *  - `remounts` — `NodeRenderer`s React unmounts and mounts again: a node
 *    whose (parent fiber, key) pair did not exist before the re-read.
 *  - `restyles` — mounted frames whose `ClassStyleInjector` regenerates and
 *    rewrites its `<style>`, which it does whenever the registry object changes.
 *
 * Two writes, each alternated so every apply is a real change:
 *
 *  - `propEdit` — one text prop on page 0 changed; every id is unchanged.
 *  - `move` — page 0's last top-level subtree moved to the front; ids are
 *    `rel:line:col`, so every node it passes is renumbered.
 *
 * No React and no DOM: the counts are derived from what the store holds before
 * and after, by the rules above, so they are deterministic. The `ms` column is
 * the `patchPages` call itself.
 *
 * ## Before / after (P6-A, 2026-09-25, this Windows box, Bun/JSC)
 *
 * 40 pages x 300 nodes, 12 mounted frames, 120-rule registry, a selection
 * held. "Before" is the trunk behaviour: a re-read replaced wholesale, the
 * registry replaced wholesale, children keyed by id. Medians of three runs.
 *
 * | scenario | rerenders | remounts | restyles | `patchPages` median |
 * |---|---|---|---|---|
 * | propEdit, before | 300 | 0 | 12 | 14.8 / 13.1 / 13.0 ms |
 * | propEdit, after | 1 | 0 | 0 | 12.3 / 11.7 / 12.2 ms |
 * | move, before | 3 | 297 | 12 | 13.8 / 14.0 / 13.8 ms |
 * | move, after | 300 | 0 | 0 | 16.0 / 16.8 / 16.1 ms |
 *
 * A move re-renders every node it renumbered either way; before, 297 of those
 * renders were a full unmount and mount (new DOM, every effect torn down and
 * re-run). The move's extra ~2.5 ms in the store is carrying the keys: one
 * content alignment of the page, which the selection follower then reuses.
 *
 * `POST_WRITE_RESYNC_BUDGETS` pins the "after" counts; a count above its budget
 * fails the bench.
 */
import { performance } from 'node:perf_hooks'
import { summarize, type LatencySummary } from './stats'

export interface PostWriteResyncShape {
  pages: number
  nodesPerPage: number
  mountedFrames: number
  styleRules: number
  iterations: number
  /**
   * Hold a selection on page 0 while re-reading, as there is after every
   * canvas gesture. The store then aligns the re-read page to carry the
   * selection over (`reparseNodeFollow.ts`) — work trunk already paid, which
   * the render-key carry now shares.
   */
  holdSelection: boolean
}

export const FULL_RESYNC_SHAPE: PostWriteResyncShape = {
  pages: 40,
  nodesPerPage: 300,
  mountedFrames: 12,
  styleRules: 120,
  iterations: 40,
  holdSelection: true,
}

export type PostWriteResyncScenario = 'propEdit' | 'move'

export interface PostWriteResyncCounts {
  rerenders: number
  remounts: number
  restyles: number
}

/** Upper bounds on the counts, per scenario. Deterministic, so exact. */
export const POST_WRITE_RESYNC_BUDGETS: Record<PostWriteResyncScenario, (shape: PostWriteResyncShape) => PostWriteResyncCounts> = {
  // The edited node, nothing else.
  propEdit: () => ({ rerenders: 1, remounts: 0, restyles: 0 }),
  // Every node the move renumbered re-renders (its id changed) plus the
  // parent whose child order changed; nothing remounts.
  move: (shape) => ({ rerenders: shape.nodesPerPage, remounts: 0, restyles: 0 }),
}

export interface PostWriteResyncResult {
  shape: PostWriteResyncShape
  scenarios: Record<PostWriteResyncScenario, { counts: PostWriteResyncCounts; patchMs: LatencySummary }>
}

interface SpecNode {
  name: string
  moduleId: string
  props: Record<string, unknown>
  classIds: string[]
  children: SpecNode[]
}

/** Same BFS shape the subscriber sweep builds: 4 children per parent, two containers + two texts. */
function buildSpec(prefix: string, target: number, ruleCount: number): SpecNode {
  const root: SpecNode = { name: `${prefix}-n0`, moduleId: 'base.body', props: {}, classIds: [], children: [] }
  let counter = 1
  const queue = [root]
  while (counter < target && queue.length > 0) {
    const parent = queue.shift()!
    for (let i = 0; i < 4 && counter < target; i++) {
      const n = counter++
      const isContainer = i < 2
      const node: SpecNode = {
        name: `${prefix}-n${n}`,
        moduleId: isContainer ? 'base.container' : 'base.text',
        props: isContainer ? { tag: 'div' } : { text: `node ${prefix}-n${n}`, tag: 'p' },
        classIds: [`rule-${n % ruleCount}`],
        children: [],
      }
      if (isContainer) queue.push(node)
      parent.children.push(node)
    }
  }
  return root
}

/** One element per source line, in document order: the id is its `rel:line:col`. */
function toPage(pageId: string, file: string, root: SpecNode, edit?: { name: string; text: string }) {
  const nodes: Record<string, unknown> = {}
  let line = 1
  const place = (spec: SpecNode, depth: number, parentId: string | null): string => {
    const id = `${file}:${line++}:${depth * 2 + 1}`
    const children = spec.children.map((child) => place(child, depth + 1, id))
    const props = edit && edit.name === spec.name ? { ...spec.props, text: edit.text } : { ...spec.props }
    nodes[id] = {
      id,
      moduleId: spec.moduleId,
      props,
      breakpointOverrides: {},
      children,
      classIds: [...spec.classIds],
      parentId,
    }
    return id
  }
  const rootNodeId = place(root, 0, null)
  return { id: pageId, slug: pageId === 'rs0-page' ? 'index' : pageId, title: pageId, nodes, rootNodeId }
}

function registry(count: number): Record<string, unknown> {
  const rules: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    rules[`rule-${i}`] = {
      id: `rule-${i}`,
      name: `rule-${i}`,
      kind: 'class',
      selector: `.rule-${i}`,
      order: i,
      styles: { color: `var(--c-${i % 7})`, paddingTop: `${i % 5}px` },
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
  }
  return rules
}

interface TreeLike {
  nodes: Record<string, { children: string[] } | undefined>
  rootNodeId: string
}

/** Rerenders and remounts one page's `NodeRenderer`s pay for `before` -> `after`, by the rules in this file's doc. */
function reconcileCounts(
  before: TreeLike,
  after: TreeLike,
  keyBefore: (id: string) => string,
  keyAfter: (id: string) => string,
): { rerenders: number; remounts: number } {
  let rerenders = 0
  let remounts = 0
  const walk = (afterId: string, beforeId: string | null) => {
    const node = after.nodes[afterId]
    if (!node) return
    if (beforeId === null) {
      remounts++
      for (const child of node.children) walk(child, null)
      return
    }
    if (afterId !== beforeId || node !== before.nodes[beforeId]) rerenders++
    const fibers = new Map((before.nodes[beforeId]?.children ?? []).map((id) => [keyBefore(id), id]))
    for (const child of node.children) walk(child, fibers.get(keyAfter(child)) ?? null)
  }
  // The root is rendered unkeyed, in the same place, whatever its id.
  walk(after.rootNodeId, before.rootNodeId)
  return { rerenders, remounts }
}

/**
 * Runs both scenarios against the LIVE editor store. Leaves the store loaded
 * with the synthetic site; the caller resets it.
 */
export async function runPostWriteResync(shape: PostWriteResyncShape): Promise<PostWriteResyncResult> {
  await import('../../../src/modules/base')
  const { useEditorStore } = await import('../../../src/admin/pages/site/store/store')
  const { nodeRenderKey } = await import('../../../src/admin/pages/site/canvas/nodeRenderKeys')
  type S = ReturnType<typeof useEditorStore.getState>
  type PatchInput = Parameters<S['patchPages']>[0]

  const specs = Array.from({ length: shape.pages }, (_, i) => buildSpec(`rs${i}`, shape.nodesPerPage, shape.styleRules))
  const pageOf = (i: number, root = specs[i]!, edit?: { name: string; text: string }) =>
    toPage(`rs${i}-page`, `pages/Rs${i}.tsx`, root, edit)

  useEditorStore.setState({ site: null, _historyPast: [], _historyFuture: [], selectedNodeIds: [], selectedNodeId: null })
  useEditorStore.getState().createSite('Resync')
  const base = useEditorStore.getState().site
  if (!base) throw new Error('createSite produced no site — update postWriteResync.')
  const site = structuredClone(base) as unknown as { pages: unknown[]; styleRules: Record<string, unknown> }
  site.pages = specs.map((_, i) => pageOf(i))
  site.styleRules = registry(shape.styleRules)
  useEditorStore.getState().loadSite(site as unknown as Parameters<S['loadSite']>[0])

  const pageId = 'rs0-page'
  const page = () => useEditorStore.getState().site!.pages.find((p) => p.id === pageId)! as unknown as TreeLike
  const spec0 = specs[0]!
  const moved: SpecNode = { ...spec0, children: [spec0.children[spec0.children.length - 1]!, ...spec0.children.slice(0, -1)] }
  const editTarget = spec0.children[2]!.name // a top-level text node

  const variants: Record<PostWriteResyncScenario, [PatchInput['pages'][number], PatchInput['pages'][number]]> = {
    propEdit: [
      pageOf(0, spec0, { name: editTarget, text: 'edited' }) as unknown as PatchInput['pages'][number],
      pageOf(0) as unknown as PatchInput['pages'][number],
    ],
    move: [
      pageOf(0, moved) as unknown as PatchInput['pages'][number],
      pageOf(0) as unknown as PatchInput['pages'][number],
    ],
  }

  const run = (scenario: PostWriteResyncScenario) => {
    const [forward, back] = variants[scenario]
    const root = page()
    const held = root.nodes[root.rootNodeId]!.children[0]!
    if (shape.holdSelection) useEditorStore.getState().selectNode(held, 'replace')
    else useEditorStore.getState().selectNode(null, 'replace')
    const apply = (read: PatchInput['pages'][number]): { ms: number; counts: PostWriteResyncCounts } => {
      const beforePage = page()
      const beforeKeys = new Map(Object.keys(beforePage.nodes).map((id) => [id, nodeRenderKey(pageId, id)]))
      const beforeRules = useEditorStore.getState().site!.styleRules
      // A re-read is a fresh object graph every time, as it is off the wire.
      const fresh = structuredClone(read)
      const rules = registry(shape.styleRules) as PatchInput['styleRules']
      const t0 = performance.now()
      useEditorStore.getState().patchPages({ pages: [fresh], styleRules: rules })
      const ms = performance.now() - t0
      const { rerenders, remounts } = reconcileCounts(
        beforePage,
        page(),
        (id) => beforeKeys.get(id) ?? id,
        (id) => nodeRenderKey(pageId, id),
      )
      const restyles = useEditorStore.getState().site!.styleRules === beforeRules ? 0 : shape.mountedFrames
      return { ms, counts: { rerenders, remounts, restyles } }
    }
    for (let i = 0; i < 4; i++) apply(i % 2 ? back : forward) // warm-up
    const samples: number[] = []
    let counts: PostWriteResyncCounts = { rerenders: 0, remounts: 0, restyles: 0 }
    for (let i = 0; i < shape.iterations; i++) {
      const result = apply(i % 2 ? back : forward)
      samples.push(result.ms)
      // Forward and back are mirror images; keep the worse of the two.
      counts = {
        rerenders: Math.max(counts.rerenders, result.counts.rerenders),
        remounts: Math.max(counts.remounts, result.counts.remounts),
        restyles: Math.max(counts.restyles, result.counts.restyles),
      }
    }
    return { counts, patchMs: summarize(samples) }
  }

  return { shape, scenarios: { propEdit: run('propEdit'), move: run('move') } }
}

/** Scenarios whose counts exceed their budget. Empty when within budget. */
export function postWriteResyncBreaches(result: PostWriteResyncResult): string[] {
  const breaches: string[] = []
  for (const scenario of Object.keys(result.scenarios) as PostWriteResyncScenario[]) {
    const budget = POST_WRITE_RESYNC_BUDGETS[scenario](result.shape)
    const { counts } = result.scenarios[scenario]
    for (const key of ['rerenders', 'remounts', 'restyles'] as const) {
      if (counts[key] > budget[key]) breaches.push(`${scenario}: ${key} ${counts[key]} > budget ${budget[key]}`)
    }
  }
  return breaches
}
