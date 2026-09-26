/**
 * ERR-5 — after a reparse, everything the canvas is holding follows the
 * ELEMENT, never the address (`docs/audits/2026-09-23-studio-audit/02-errors-client.md`).
 *
 * The audit's `selectionRepointProbe`: select `a.tsx:4:5` ("Body"). An agent
 * write inserts a line above it and `patchPages` runs. The selection used to
 * stay on `a.tsx:4:5` — which now names "NEW BANNER" — so the next inspector
 * keystroke, Delete or ⌘D went to disk against the banner. After a full
 * `loadSite`, `selectedNodeIds` kept an id nothing on the board had.
 *
 * Both reload paths now map selection, hover, the inline-edit session and the
 * entered-instance stack through `reparseNodeFollow.ts`, and drop what has no
 * honest counterpart. Every case here asserts on WHAT the held id names (its
 * text), not only on the id, because "the id resolves" is exactly the check
 * the bug passed.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { getCanvasHover, setCanvasHover } from '@site/canvas/canvasHover'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const ROOT = 'a.tsx:2:3'
const TITLE = 'a.tsx:3:5'

function text(id: string, value: string) {
  return makeNode({ id, moduleId: 'base.text', props: { text: value, tag: 'p' } })
}

/** The page as the user opened it: a title, then "Body" on line 4. */
function pageBefore(): Page {
  return makePage({
    id: 'home',
    slug: 'index',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', props: { tag: 'main' }, children: [TITLE, 'a.tsx:4:5'] }),
      [TITLE]: text(TITLE, 'Title'),
      'a.tsx:4:5': text('a.tsx:4:5', 'Body'),
    },
  })
}

/** The agent's write: a banner on line 4. "Body" is pushed to line 5, and `a.tsx:4:5` is now the banner. */
function pageWithBannerAbove(): Page {
  return makePage({
    id: 'home',
    slug: 'index',
    rootNodeId: ROOT,
    nodes: {
      [ROOT]: makeNode({
        id: ROOT,
        moduleId: 'base.container',
        props: { tag: 'main' },
        children: [TITLE, 'a.tsx:4:5', 'a.tsx:5:5'],
      }),
      [TITLE]: text(TITLE, 'Title'),
      'a.tsx:4:5': text('a.tsx:4:5', 'NEW BANNER'),
      'a.tsx:5:5': text('a.tsx:5:5', 'Body'),
    },
  })
}

function otherPage(): Page {
  return makePage({
    id: 'about',
    slug: 'about',
    rootNodeId: 'b.tsx:2:3',
    nodes: { 'b.tsx:2:3': makeNode({ id: 'b.tsx:2:3', moduleId: 'base.container' }) },
  })
}

const store = () => useEditorStore.getState()

/** The text of the node an id names on the active page, or `undefined` when it names nothing. */
function textOf(id: string | null | undefined): unknown {
  if (!id) return undefined
  const page = store().site?.pages.find((p) => p.id === 'home')
  return page?.nodes[id]?.props.text
}

/** Every id the canvas holds must resolve through the O(1) index — no dangling ids. */
function expectNoDanglingIds() {
  const s = store()
  const held = [
    ...s.selectedNodeIds,
    ...(s.selectedNodeId ? [s.selectedNodeId] : []),
    ...(getCanvasHover() ? [getCanvasHover()!.nodeId] : []),
    ...(s.activeInlineEdit ? [s.activeInlineEdit.nodeId] : []),
    ...s.enteredInstanceIds,
  ]
  for (const id of held) expect(s._nodeIdToPageIds.has(id)).toBe(true)
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    activeInlineEdit: null,
    enteredInstanceIds: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
  } as Parameters<typeof useEditorStore.setState>[0])
  store().loadSite(makeSite({ pages: [pageBefore(), otherPage()] }))
  store().setActivePage('home')
  store().selectNode('a.tsx:4:5')
  expect(textOf(store().selectedNodeId)).toBe('Body')
})

describe('patchPages — the selection follows the element an agent write shifted (ERR-5 probe)', () => {
  it('moves the selection to "Body"\'s new id instead of leaving it on the banner', () => {
    store().patchPages({ pages: [pageWithBannerAbove()] })

    expect(store().selectedNodeIds).toEqual(['a.tsx:5:5'])
    expect(store().selectedNodeId).toBe('a.tsx:5:5')
    expect(textOf(store().selectedNodeId)).toBe('Body')
    expectNoDanglingIds()
  })

  it('carries hover, the inline-edit session and the entered-instance stack the same way', () => {
    setCanvasHover('a.tsx:4:5', 'studio')
    useEditorStore.setState({
      enteredInstanceIds: ['a.tsx:4:5'],
      activeInlineEdit: {
        nodeId: 'a.tsx:4:5',
        prop: 'text',
        breakpointId: 'studio',
        frameId: null,
        localeOverride: null,
        multiline: true,
        initialValue: 'Body',
        committed: false,
      },
    } as Parameters<typeof useEditorStore.setState>[0])

    store().patchPages({ pages: [pageWithBannerAbove()] })

    expect(getCanvasHover()?.nodeId).toBe('a.tsx:5:5')
    expect(store().activeInlineEdit?.nodeId).toBe('a.tsx:5:5')
    expect(store().enteredInstanceIds).toEqual(['a.tsx:5:5'])
    expectNoDanglingIds()
  })

  it('follows content through a reorder that permutes line numbers', () => {
    // The agent swapped the two paragraphs: `a.tsx:4:5` is now "Title".
    store().patchPages({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          rootNodeId: ROOT,
          nodes: {
            [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', props: { tag: 'main' }, children: [TITLE, 'a.tsx:4:5'] }),
            [TITLE]: text(TITLE, 'Body'),
            'a.tsx:4:5': text('a.tsx:4:5', 'Title'),
          },
        }),
      ],
    })

    expect(store().selectedNodeIds).toEqual([TITLE])
    expect(textOf(store().selectedNodeId)).toBe('Body')
  })

  it('drops the selection when the selected element was deleted, instead of landing on a neighbour', () => {
    store().patchPages({
      pages: [
        makePage({
          id: 'home',
          slug: 'index',
          rootNodeId: ROOT,
          nodes: {
            [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', props: { tag: 'main' }, children: [TITLE] }),
            [TITLE]: text(TITLE, 'Title'),
          },
        }),
      ],
    })

    expect(store().selectedNodeIds).toEqual([])
    expect(store().selectedNodeId).toBeNull()
  })

  it('leaves a selection on an untouched page exactly as it was', () => {
    store().setActivePage('about')
    store().selectNode('b.tsx:2:3')
    store().patchPages({ pages: [pageWithBannerAbove()] })
    expect(store().selectedNodeIds).toEqual(['b.tsx:2:3'])
  })
})

describe('loadSite — a full reload never leaves a dangling or re-pointed id (ERR-5)', () => {
  it('follows the selected element through a full reparse of the same project', () => {
    store().loadSite(makeSite({ pages: [pageWithBannerAbove(), otherPage()] }))

    expect(store().selectedNodeIds).toEqual(['a.tsx:5:5'])
    expect(textOf(store().selectedNodeId)).toBe('Body')
    expectNoDanglingIds()
  })

  it('drops every held id whose element the reload no longer has', () => {
    setCanvasHover('a.tsx:4:5', 'studio')
    store().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'home',
            slug: 'index',
            rootNodeId: ROOT,
            nodes: {
              [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', props: { tag: 'main' }, children: [TITLE] }),
              [TITLE]: text(TITLE, 'Title'),
            },
          }),
          otherPage(),
        ],
      }),
    )

    expect(store().selectedNodeIds).toEqual([])
    expect(store().selectedNodeId).toBeNull()
    expect(getCanvasHover()).toBeNull()
    expectNoDanglingIds()
  })

  it('does not carry a selection into a DIFFERENT project that happens to share the address', () => {
    // A project switch: different page set, and `a.tsx:4:5` exists in the new
    // project too — as something else entirely.
    store().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'home',
            slug: 'index',
            rootNodeId: ROOT,
            nodes: {
              [ROOT]: makeNode({ id: ROOT, moduleId: 'base.container', props: { tag: 'main' }, children: ['a.tsx:4:5'] }),
              'a.tsx:4:5': text('a.tsx:4:5', 'Pricing'),
            },
          }),
        ],
      }),
    )

    expect(store().selectedNodeIds).toEqual([])
    expect(store().selectedNodeId).toBeNull()
  })
})
