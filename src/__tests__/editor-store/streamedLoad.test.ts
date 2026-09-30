/**
 * `streamedLoadSlice` (P6-B) — a project opening while its pages are still
 * arriving.
 *
 * Covers:
 *   - `openStreamedLoad` puts the first pages in the store and names the rest
 *     as pending;
 *   - `receiveStreamedPages` APPENDS (never inserts: undo patches address pages
 *     by position), indexes the new nodes, clears them from pending, and marks
 *     nothing dirty and records no history;
 *   - `finishStreamedLoad` puts the pages back in page order when the undo
 *     stack is empty, and leaves the arrival order alone when it is not;
 *   - a full `loadSite` clears whatever was still pending;
 *   - `adoptLoadedFramework` (the token extraction a load runs after itself)
 *     lands without history or a dirty mark, reconciles the framework classes,
 *     and never overwrites a framework the person changed meanwhile.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import type { Page } from '@core/page-tree'
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
    pendingPages: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

function page(id: string, slug = id): Page {
  const root = `${id}-root`
  const text = `${id}-text`
  return makePage({
    id,
    slug,
    title: id.toUpperCase(),
    rootNodeId: root,
    nodes: {
      [root]: makeNode({ id: root, moduleId: 'base.body', children: [text] }),
      [text]: makeNode({ id: text, moduleId: 'base.text', props: { text: id }, parentId: root }),
    },
  })
}

/** Pages `a` (home), `b`, `c`, `d` in page order; `c` arrives first, as the frame in view. */
function openWithC() {
  const site = makeSite({ pages: [page('c')] })
  useEditorStore.getState().openStreamedLoad(site, [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'd', title: 'D' },
  ])
}

describe('streamed load', () => {
  it('opens with the pages that arrived and names the rest as pending', () => {
    openWithC()
    const state = useEditorStore.getState()
    expect(state.site!.pages.map((p) => p.id)).toEqual(['c'])
    expect(state.pendingPages.map((p) => p.id)).toEqual(['a', 'b', 'd'])
    expect(state.activePageId).toBe('c')
  })

  it('appends later pages, indexes their nodes, and neither dirties nor records history', () => {
    openWithC()
    useEditorStore.getState().receiveStreamedPages([page('a', 'index'), page('d')])
    const state = useEditorStore.getState()
    expect(state.site!.pages.map((p) => p.id)).toEqual(['c', 'a', 'd'])
    expect(state.pendingPages.map((p) => p.id)).toEqual(['b'])
    expect([...(state._nodeIdToPageIds.get('d-text') ?? [])]).toEqual(['d'])
    expect(state.site!.pages[2]!.nodes['d-text']!.parentId).toBe('d-root')
    expect(state.hasUnsavedChanges).toBe(false)
    expect(state._historyPast).toEqual([])
  })

  it('ignores a page it already holds', () => {
    openWithC()
    const before = useEditorStore.getState().site
    useEditorStore.getState().receiveStreamedPages([page('c')])
    expect(useEditorStore.getState().site).toBe(before)
  })

  it('puts the pages back in page order when nothing holds a position', () => {
    openWithC()
    useEditorStore.getState().receiveStreamedPages([page('a', 'index'), page('d')])
    useEditorStore.getState().receiveStreamedPages([page('b')])
    useEditorStore.getState().finishStreamedLoad(['a', 'b', 'c', 'd'])
    const state = useEditorStore.getState()
    expect(state.site!.pages.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(state.pendingPages).toEqual([])
    // Node indexes are by id, so they survive the reorder untouched.
    expect([...(state._nodeIdToPageIds.get('b-text') ?? [])]).toEqual(['b'])
  })

  it('keeps the arrival order when an edit made during the stream is on the undo stack', () => {
    openWithC()
    // An edit to the page in view while the rest is still arriving: its undo
    // patch addresses `pages[0]`, so `c` must stay at index 0.
    useEditorStore.getState().updateNodeProps('c-text', { text: 'edited' })
    expect(useEditorStore.getState()._historyPast.length).toBe(1)
    useEditorStore.getState().receiveStreamedPages([page('a', 'index'), page('b'), page('d')])
    useEditorStore.getState().finishStreamedLoad(['a', 'b', 'c', 'd'])
    expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual(['c', 'a', 'b', 'd'])

    // …and undo still lands on the page it was made on.
    useEditorStore.getState().undo()
    const c = useEditorStore.getState().site!.pages.find((p) => p.id === 'c')!
    expect(c.nodes['c-text']!.props.text).toBe('c')
    const a = useEditorStore.getState().site!.pages.find((p) => p.id === 'a')!
    expect(a.nodes['a-text']!.props.text).toBe('a')
  })

  it('a whole-document load clears whatever was still pending', () => {
    openWithC()
    useEditorStore.getState().loadSite(makeSite({ pages: [page('a', 'index'), page('b')] }))
    expect(useEditorStore.getState().pendingPages).toEqual([])
  })

  it('abandoning an opened load drops the pending pages', () => {
    openWithC()
    useEditorStore.getState().abandonStreamedLoad()
    expect(useEditorStore.getState().pendingPages).toEqual([])
    expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual(['c'])
  })
})

describe('adoptLoadedFramework', () => {
  const extracted = {
    colors: {
      tokens: [
        {
          id: 'primary-token',
          category: 'Brand',
          slug: 'primary',
          lightValue: 'hsla(238, 100%, 62%, 1)',
          darkValue: 'hsla(238, 100%, 42%, 1)',
          darkModeEnabled: false,
          generateUtilities: { text: true, background: false, border: false, fill: false },
          generateTransparent: false,
          generateShades: { enabled: false, count: 0 },
          generateTints: { enabled: false, count: 0 },
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  }

  it('takes the extraction as part of the read: framework classes appear, nothing is dirty, nothing is undoable', () => {
    useEditorStore.getState().loadSite(makeSite({ pages: [page('a', 'index')] }))
    const loaded = useEditorStore.getState().site!.settings.framework
    expect(useEditorStore.getState().adoptLoadedFramework(loaded, extracted)).toBe(true)
    const state = useEditorStore.getState()
    expect(state.site!.settings.framework).toEqual(extracted)
    expect(Object.values(state.site!.styleRules).some((rule) => rule.name === 'text-primary')).toBe(true)
    expect(state.hasUnsavedChanges).toBe(false)
    expect(state._historyPast).toEqual([])
  })

  it('leaves a framework the person changed after the load alone', () => {
    useEditorStore.getState().loadSite(makeSite({ pages: [page('a', 'index')] }))
    const loaded = useEditorStore.getState().site!.settings.framework
    const theirs = { colors: { tokens: [{ ...extracted.colors.tokens[0]!, id: 'theirs', slug: 'accent' }] } }
    useEditorStore.setState({ site: { ...useEditorStore.getState().site!, settings: { ...useEditorStore.getState().site!.settings, framework: theirs } } } as Parameters<typeof useEditorStore.setState>[0])
    expect(useEditorStore.getState().adoptLoadedFramework(loaded, extracted)).toBe(false)
    expect(useEditorStore.getState().site!.settings.framework).toEqual(theirs)
  })
})
