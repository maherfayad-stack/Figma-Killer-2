/**
 * P2-I (PERF-12) — the page list chrome reads keeps its identity across a
 * keystroke. Mutative replaces `site.pages` on every node edit; before this,
 * the Explorer's page list, the document switcher and the template picker all
 * subscribed to that array and re-rendered on every character typed.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { selectPageDirectory, selectTemplatePages } from '@site/store/slices/pageDirectory'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

function load() {
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['copy'] })
  const copy = makeNode({ id: 'copy', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } })
  const home = makePage({ id: 'home', slug: 'index', title: 'Home', rootNodeId: 'root', nodes: { root, copy } })
  const tRoot = makeNode({ id: 't-root', moduleId: 'base.body' })
  const layout = makePage({
    id: 'layout',
    slug: 'layout',
    title: 'Layout',
    rootNodeId: 't-root',
    nodes: { 't-root': tRoot },
    template: { enabled: true, target: { kind: 'everywhere' } },
  } as Parameters<typeof makePage>[0])
  useEditorStore.getState().loadSite(makeSite({ pages: [home, layout] }))
  useEditorStore.setState({ activePageId: 'home' })
}

beforeEach(load)

describe('selectPageDirectory', () => {
  it('lists every page, and keeps the SAME array across an edit to a node', () => {
    const before = selectPageDirectory(useEditorStore.getState())
    expect(before.map((entry) => [entry.id, entry.title, entry.isTemplate])).toEqual([
      ['home', 'Home', false],
      ['layout', 'Layout', true],
    ])
    const pagesBefore = useEditorStore.getState().site?.pages

    useEditorStore.getState().updateNodeProps('copy', { text: 'Hello, world' })

    // The pages array DID change — that is the whole problem.
    expect(useEditorStore.getState().site?.pages).not.toBe(pagesBefore)
    // The directory did not.
    expect(selectPageDirectory(useEditorStore.getState())).toBe(before)
  })

  it('changes when a page is renamed', () => {
    const before = selectPageDirectory(useEditorStore.getState())
    useEditorStore.getState().renamePage('home', 'Start')
    const after = selectPageDirectory(useEditorStore.getState())
    expect(after).not.toBe(before)
    expect(after[0]?.title).toBe('Start')
  })
})

describe('selectTemplatePages', () => {
  it('keeps the same array when an ordinary page is edited', () => {
    const before = selectTemplatePages(useEditorStore.getState())
    expect(before.map((page) => page.id)).toEqual(['layout'])
    useEditorStore.getState().updateNodeProps('copy', { text: 'Edited' })
    expect(selectTemplatePages(useEditorStore.getState())).toBe(before)
  })
})
