/**
 * PERF-6 — `patchPages` reconciles a re-read against what the store holds.
 *
 * A post-write re-read is a brand-new object graph even where nothing changed.
 * `patchPages` used to put it in wholesale, so:
 *  - every node object of the touched page was new, and every `NodeRenderer`
 *    of the frame (which selects its node by identity) re-rendered;
 *  - `styleRules` was a new object, so every mounted frame's
 *    `ClassStyleInjector` regenerated and rewrote its `<style>`;
 *  - a node whose `rel:line:col` id a write renumbered got a new React key and
 *    remounted.
 *
 * Now a deep-equal node, rule, registry or page keeps its previous object, and
 * a renumbered node keeps the React key it rendered under
 * (`canvas/nodeRenderKeys.ts`), carried through the content alignment
 * `reparseNodeFollow.ts` already builds.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { nodeRenderKey } from '@site/canvas/nodeRenderKeys'
import type { Page, PageNode, StyleRule } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedFrameIds: [],
    hasUnsavedChanges: false,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

const rule = (name: string, color = 'red'): StyleRule => ({
  id: name,
  name,
  kind: 'class',
  selector: `.${name}`,
  order: 0,
  styles: { color },
  contextStyles: {},
  createdAt: 0,
  updatedAt: 0,
})

/** `[id, text]` children of one body, in order — each a fresh object graph. */
function listPage(children: ReadonlyArray<readonly [string, string]>, extra: Record<string, PageNode> = {}): Page {
  const nodes: Record<string, PageNode> = {
    'p.tsx:1:1': makeNode({ id: 'p.tsx:1:1', moduleId: 'base.body', children: children.map(([id]) => id) }),
    ...extra,
  }
  for (const [id, text] of children) nodes[id] = makeNode({ id, moduleId: 'base.text', props: { text } })
  return makePage({ id: 'home', slug: 'index', title: 'Home', rootNodeId: 'p.tsx:1:1', nodes })
}

function aboutPage(): Page {
  return makePage({
    id: 'about',
    slug: 'about',
    title: 'About',
    rootNodeId: 'a.tsx:1:1',
    nodes: { 'a.tsx:1:1': makeNode({ id: 'a.tsx:1:1', moduleId: 'base.body' }) },
  })
}

function load(home: Page) {
  const site = makeSite({ pages: [home, aboutPage()] })
  site.styleRules = { card: rule('card'), hero: rule('hero') }
  useEditorStore.getState().loadSite(site)
  useEditorStore.getState().setActivePage('home')
}

const homeNow = () => useEditorStore.getState().site!.pages.find((p) => p.id === 'home')!

const ROWS = [
  ['p.tsx:3:5', 'Alpha'],
  ['p.tsx:5:5', 'Beta'],
  ['p.tsx:6:5', 'Gamma'],
  ['p.tsx:7:5', 'Delta'],
] as const

describe('patchPages — node identity (PERF-6)', () => {
  it('keeps every node the re-read left unchanged, and replaces only the edited one', () => {
    load(listPage(ROWS))
    const before = homeNow()

    // A prop write re-read: same ids, one text changed.
    useEditorStore.getState().patchPages({
      pages: [listPage(ROWS.map(([id, text]) => [id, id === 'p.tsx:5:5' ? 'Beta, edited' : text] as const))],
    })

    const after = homeNow()
    expect(after.nodes['p.tsx:5:5']!.props.text).toBe('Beta, edited')
    expect(after.nodes['p.tsx:5:5']).not.toBe(before.nodes['p.tsx:5:5'])
    for (const id of ['p.tsx:1:1', 'p.tsx:3:5', 'p.tsx:6:5', 'p.tsx:7:5']) {
      expect(after.nodes[id]).toBe(before.nodes[id]!)
    }
  })

  it('keeps the page object itself when the re-read is deep-equal to it', () => {
    load(listPage(ROWS))
    const before = homeNow()
    const about = useEditorStore.getState().site!.pages[1]

    useEditorStore.getState().patchPages({ pages: [listPage(ROWS)] })

    expect(homeNow()).toBe(before)
    expect(useEditorStore.getState().site!.pages[1]).toBe(about)
  })

  it('keeps unchanged nodes above a renumbering write and reuses nothing below it', () => {
    load(listPage(ROWS))
    const before = homeNow()

    // Beta deleted: everything under it moves up a line.
    useEditorStore.getState().patchPages({
      pages: [listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Gamma'], ['p.tsx:6:5', 'Delta']])],
    })

    const after = homeNow()
    expect(after.nodes['p.tsx:3:5']).toBe(before.nodes['p.tsx:3:5']!)
    expect(after.nodes['p.tsx:5:5']!.props.text).toBe('Gamma')
    expect(after.nodes['p.tsx:7:5']).toBeUndefined()
  })
})

describe('patchPages — style registry identity (PERF-6)', () => {
  it('keeps the registry object when the recompute is deep-equal to it', () => {
    load(listPage(ROWS))
    const registry = useEditorStore.getState().site!.styleRules

    useEditorStore.getState().patchPages({
      pages: [listPage(ROWS)],
      styleRules: { card: rule('card'), hero: rule('hero') },
    })

    expect(useEditorStore.getState().site!.styleRules).toBe(registry)
  })

  it('keeps every unchanged rule object when one rule changed, and drops a deleted one', () => {
    load(listPage(ROWS))
    const registry = useEditorStore.getState().site!.styleRules

    useEditorStore.getState().patchPages({
      pages: [listPage(ROWS)],
      styleRules: { card: rule('card'), hero: rule('hero', 'blue') },
    })
    const next = useEditorStore.getState().site!.styleRules
    expect(next).not.toBe(registry)
    expect(next.card).toBe(registry.card!)
    expect(next.hero).not.toBe(registry.hero!)
    expect(next.hero!.styles).toEqual({ color: 'blue' })

    useEditorStore.getState().patchPages({ pages: [listPage(ROWS)], styleRules: { hero: rule('hero', 'blue') } })
    const pruned = useEditorStore.getState().site!.styleRules
    expect(Object.keys(pruned)).toEqual(['hero'])
    expect(pruned.hero).toBe(next.hero!)
  })

  it('keeps the conditions array when the recompute is deep-equal to it', () => {
    load(listPage(ROWS))
    const conditions = [{ id: 'dark', name: 'Dark', kind: 'media', query: '(prefers-color-scheme: dark)' }]
    useEditorStore.getState().patchPages({
      pages: [listPage(ROWS)],
      conditions: structuredClone(conditions) as never,
    })
    const kept = useEditorStore.getState().site!.conditions

    useEditorStore.getState().patchPages({
      pages: [listPage(ROWS)],
      conditions: structuredClone(conditions) as never,
    })

    expect(useEditorStore.getState().site!.conditions).toBe(kept)
  })
})

describe('patchPages — moved nodes keep their render key (PERF-6)', () => {
  it('re-keys every renumbered node to the key it rendered under', () => {
    // Alpha spans two lines, so moving Gamma to the front renumbers all three.
    load(listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Beta'], ['p.tsx:6:5', 'Gamma']]))

    useEditorStore.getState().patchPages({
      pages: [listPage([['p.tsx:3:5', 'Gamma'], ['p.tsx:4:5', 'Alpha'], ['p.tsx:6:5', 'Beta']])],
    })

    expect(nodeRenderKey('home', 'p.tsx:4:5')).toBe('p.tsx:3:5') // Alpha
    expect(nodeRenderKey('home', 'p.tsx:6:5')).toBe('p.tsx:5:5') // Beta
    expect(nodeRenderKey('home', 'p.tsx:3:5')).toBe('p.tsx:6:5') // Gamma
    expect(nodeRenderKey('home', 'p.tsx:1:1')).toBe('p.tsx:1:1')
  })

  it('carries a key across two successive renumbering writes', () => {
    load(listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Beta']]))
    useEditorStore.getState().patchPages({ pages: [listPage([['p.tsx:3:5', 'Beta'], ['p.tsx:4:5', 'Alpha']])] })
    useEditorStore.getState().patchPages({ pages: [listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Beta']])] })

    expect(nodeRenderKey('home', 'p.tsx:3:5')).toBe('p.tsx:3:5') // Alpha, home again
    expect(nodeRenderKey('home', 'p.tsx:5:5')).toBe('p.tsx:5:5') // Beta, home again
  })

  it('never gives two siblings the same key when a new node inherits a moved one’s address', () => {
    load(listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Beta']]))

    // A banner inserted on line 3: it takes Alpha's old id.
    useEditorStore.getState().patchPages({
      pages: [listPage([['p.tsx:3:5', 'Banner'], ['p.tsx:5:5', 'Alpha'], ['p.tsx:7:5', 'Beta']])],
    })

    const children = homeNow().nodes['p.tsx:1:1']!.children
    const keys = children.map((id) => nodeRenderKey('home', id))
    expect(new Set(keys).size).toBe(children.length)
    expect(nodeRenderKey('home', 'p.tsx:5:5')).toBe('p.tsx:3:5') // Alpha kept its key
    expect(nodeRenderKey('home', 'p.tsx:7:5')).toBe('p.tsx:5:5') // Beta kept its key
    expect(nodeRenderKey('home', 'p.tsx:3:5')).not.toBe('p.tsx:3:5') // the banner is new
  })

  it('keeps sibling keys unique for a node created locally after the re-read', () => {
    load(listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Beta']]))
    useEditorStore.getState().patchPages({ pages: [listPage([['p.tsx:4:5', 'Alpha'], ['p.tsx:6:5', 'Beta']])] })

    // No node has id `p.tsx:3:5` now, but Alpha carries it as a key; a node
    // that later takes that id before the next re-read must not collide.
    expect(nodeRenderKey('home', 'p.tsx:4:5')).toBe('p.tsx:3:5')
    expect(nodeRenderKey('home', 'p.tsx:3:5')).not.toBe('p.tsx:3:5')
  })

  it('a full reload renders every node under its own id again', () => {
    load(listPage([['p.tsx:3:5', 'Alpha'], ['p.tsx:5:5', 'Beta']]))
    useEditorStore.getState().patchPages({ pages: [listPage([['p.tsx:4:5', 'Alpha'], ['p.tsx:6:5', 'Beta']])] })
    expect(nodeRenderKey('home', 'p.tsx:4:5')).toBe('p.tsx:3:5')

    load(listPage([['p.tsx:4:5', 'Alpha'], ['p.tsx:6:5', 'Beta']]))

    expect(nodeRenderKey('home', 'p.tsx:4:5')).toBe('p.tsx:4:5')
  })
})
