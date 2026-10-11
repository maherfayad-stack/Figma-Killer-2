/**
 * Round-4 board audit #5 / #6 - a page rename and a layer rename are board
 * state (`pageNames`, `layerNames` in `.studio/boards.json`), applied back onto
 * the site document as the page title and the node label. They must
 *   - land on the board (so the autosave writes them),
 *   - be ONE undo entry whose undo gives the original title/label back,
 *   - come back after the site is re-read from disk (a reload hands the editor
 *     pages with their file names and no labels).
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { createBoard, createBoardsFile, upsertBoard } from '@core/studio-board'
import type { PageNode } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const ROOT = 'pages/Home.tsx:body'
const HEADING = 'pages/Home.tsx:4:7'

/** A Studio page the way the parser hands it over: root `...:body`, children `file:line:col`, title = file name. */
function studioPage(extra: Partial<PageNode> = {}) {
  const root = makeNode({ id: ROOT, moduleId: 'base.body', children: [HEADING] })
  const heading = makeNode({ id: HEADING, moduleId: 'base.text', props: { text: 'Hello', tag: 'h1' }, ...extra })
  return makePage({ id: 'home', slug: 'home', title: 'Home', rootNodeId: ROOT, nodes: { [ROOT]: root, [HEADING]: heading } })
}

function load() {
  useEditorStore.getState().loadSite(makeSite({ pages: [studioPage()] }))
  useEditorStore.setState({
    activePageId: 'home',
    boards: upsertBoard(createBoardsFile(), createBoard('b1', 'Board 1')),
    activeBoardId: 'b1',
    boardsLoaded: true,
    boardsDirty: false,
    _historyPast: [],
    _historyFuture: [],
  })
}

const state = () => useEditorStore.getState()
const title = () => state().site?.pages[0]?.title
const label = () => state().site?.pages[0]?.nodes[HEADING]?.label

beforeEach(load)
afterAll(() => {
  const reset = (globalThis as Record<string, unknown>).__resetEditorStoreForTests
  if (typeof reset === 'function') reset()
})

describe('renaming a Studio page', () => {
  it('is kept on the board, shown as the title, and undone in one step', () => {
    state().renamePage('home', 'Checkout')

    expect(title()).toBe('Checkout')
    expect(state().boards.pageNames).toEqual({ home: 'Checkout' })
    expect(state().boardsDirty).toBe(true)
    expect(state()._historyPast).toHaveLength(1)

    state().undo()
    expect(title()).toBe('Home')
    expect(state().boards.pageNames).toBeUndefined()

    state().redo()
    expect(title()).toBe('Checkout')
    expect(state().boards.pageNames).toEqual({ home: 'Checkout' })
  })

  it('survives the site being read again from disk', () => {
    state().renamePage('home', 'Checkout')
    state().loadSite(makeSite({ pages: [studioPage()] }))
    expect(title()).toBe('Checkout')
  })

  it('an empty name gives the file name back', () => {
    state().renamePage('home', 'Checkout')
    state().renamePage('home', '   ')
    expect(title()).toBe('Home')
    expect(state().boards.pageNames).toBeUndefined()
  })
})

describe('renaming a layer', () => {
  it('is kept on the board, shown as the label, and undone in one step', () => {
    state().renameNode(HEADING, 'Hero Title')

    expect(label()).toBe('Hero Title')
    expect(state().boards.layerNames?.map((entry) => [entry.pageId, entry.name])).toEqual([['home', 'Hero Title']])
    expect(state().boardsDirty).toBe(true)
    expect(state()._historyPast).toHaveLength(1)

    state().undo()
    expect(label()).toBeUndefined()
    expect(state().boards.layerNames).toBeUndefined()

    state().redo()
    expect(label()).toBe('Hero Title')
  })

  it('survives the site being read again, even when an edit above moved the element', () => {
    state().renameNode(HEADING, 'Hero Title')
    // After an edit above it the heading's id is a different source position.
    const moved = 'pages/Home.tsx:6:7'
    const root = makeNode({ id: ROOT, moduleId: 'base.body', children: [moved] })
    const heading = makeNode({ id: moved, moduleId: 'base.text', props: { text: 'Hello', tag: 'h1' } })
    const page = makePage({ id: 'home', slug: 'home', title: 'Home', rootNodeId: ROOT, nodes: { [ROOT]: root, [moved]: heading } })
    state().loadSite(makeSite({ pages: [page] }))

    expect(state().site?.pages[0]?.nodes[moved]?.label).toBe('Hero Title')
  })

  it('is not put on a different kind of element that took the old position', () => {
    state().renameNode(HEADING, 'Hero Title')
    const root = makeNode({ id: ROOT, moduleId: 'base.body', children: [HEADING] })
    const other = makeNode({ id: HEADING, moduleId: 'base.container' })
    const page = makePage({ id: 'home', slug: 'home', title: 'Home', rootNodeId: ROOT, nodes: { [ROOT]: root, [HEADING]: other } })
    state().loadSite(makeSite({ pages: [page] }))

    expect(state().site?.pages[0]?.nodes[HEADING]?.label).toBeUndefined()
  })

  it('renaming twice replaces the name instead of stacking entries', () => {
    state().renameNode(HEADING, 'One')
    state().renameNode(HEADING, 'Two')
    expect(state().boards.layerNames?.map((entry) => entry.name)).toEqual(['Two'])
    expect(label()).toBe('Two')
  })
})
