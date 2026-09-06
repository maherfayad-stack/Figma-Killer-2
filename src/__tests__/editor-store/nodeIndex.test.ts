/**
 * Node-lookup indexes (slices/site/nodeIndex.ts) — WS-5.2.
 *
 * Unit half: `rebuildNodeIndexes`/`applyNodeIndexPatch` against hand-built
 * `SiteDocument`s, including the meta-05 landmine this module exists to get
 * right — a node id is NOT unique across pages (a composed Next.js
 * `layout.tsx` shares one id with every route beneath it), so
 * `nodeIdToPageIds` must be many-valued and a mutation to ONE page's copy
 * must never blow away another page's mapping for the same id.
 *
 * Store half: the real editor store wires `applyNodeIndexPatch` into
 * `runHistoricMutation` (every named tree mutation), `undo`/`redo`, and
 * `rebuildNodeIndexes`/`clearNodeIndexes` into `loadSite`/`createSite`/
 * `clearSite` — asserting the index tracks the SAME store actions
 * `dirtyTracking.test.ts` exercises for `_dirtySave`, since both are fed by
 * the identical `DirtyMarks`.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import type { SiteDocument } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import {
  applyNodeIndexPatch,
  clearNodeIndexes,
  emptyNodeIndexes as emptyIndexes,
  inlineTailKey,
  nodeIndexState,
  rebuildNodeIndexes,
  textOriginKey,
} from '@site/store/slices/site/nodeIndex'
import { studioSlotValue } from '@core/utils/studioSlotSentinel'
import { lookupSlotOwner } from '@site/panels/PropertiesPanel/slotOwners'
import { makeNode, makePage, makeSite } from '../fixtures'

const SHARED_ID = 'app/blog/layout.tsx:4:7'

/**
 * Two pages whose node maps each hold an INDEPENDENT node object under the
 * SAME id — exactly how a composed layout node looks in the store (each
 * route's page carries its own copy, produced by composition at parse time,
 * not a shared reference). See STATE.md -> meta-05.
 */
function sharedNodeSite(): SiteDocument {
  const pageA = makePage({
    id: 'page-a',
    slug: 'blog-a',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [SHARED_ID] }),
      [SHARED_ID]: makeNode({ id: SHARED_ID, moduleId: 'base.nav' }),
    },
  })
  const pageB = makePage({
    id: 'page-b',
    slug: 'blog-b',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [SHARED_ID] }),
      [SHARED_ID]: makeNode({ id: SHARED_ID, moduleId: 'base.nav' }),
    },
  })
  return makeSite({ pages: [pageA, pageB] })
}

// ---------------------------------------------------------------------------
// Unit: rebuildNodeIndexes
// ---------------------------------------------------------------------------

describe('rebuildNodeIndexes', () => {
  it('is many-valued: a node id shared across pages maps to every page', () => {
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, sharedNodeSite())

    expect([...(indexes.nodeIdToPageIds.get(SHARED_ID) ?? [])].sort()).toEqual(['page-a', 'page-b'])
    // The fixture default root id ('root') is ALSO shared across both pages —
    // the ordinary case, not just the layout-chrome case.
    expect([...(indexes.nodeIdToPageIds.get('root') ?? [])].sort()).toEqual(['page-a', 'page-b'])
  })

  it('counts nodes sharing a textOrigin across the whole site', () => {
    const origin = { rel: 'src/copy.ts', line: 12, col: 4 }
    const site = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t1'] }),
            t1: makeNode({ id: 't1', moduleId: 'base.text', textOrigin: origin }),
          },
        }),
        makePage({
          id: 'page-b',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t2'] }),
            t2: makeNode({ id: 't2', moduleId: 'base.text', textOrigin: origin }),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, site)
    expect(indexes.textOriginKeyToCount.get(textOriginKey(origin))).toBe(2)
  })

  it('counts nodes sharing an inlined-component call-site tail', () => {
    const tail = 'components/Icon.jsx:3:6'
    const site = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: [`callA~${tail}`] }),
            [`callA~${tail}`]: makeNode({ id: `callA~${tail}`, moduleId: 'base.icon' }),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, site)
    expect(indexes.inlineTailToCount.get(tail)).toBe(1)
    expect(inlineTailKey(`callA~${tail}`)).toBe(tail)
    expect(inlineTailKey('plain/File.tsx:1:1')).toBeUndefined()
  })

  it('counts how many nodes carry each class id, across every page', () => {
    const site = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
            a: makeNode({ id: 'a', classIds: ['hero', 'pad'] }),
            b: makeNode({ id: 'b', classIds: ['hero'] }),
          },
        }),
        makePage({
          id: 'page-b',
          nodes: {
            root2: makeNode({ id: 'root2', moduleId: 'base.body', children: ['c'] }),
            c: makeNode({ id: 'c', classIds: ['hero'] }),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, site)

    expect(indexes.classIdToNodeCount.get('hero')).toBe(3)
    expect(indexes.classIdToNodeCount.get('pad')).toBe(1)
    // A class nobody carries is absent, not 0 — callers default.
    expect(indexes.classIdToNodeCount.has('unused')).toBe(false)
  })

  it('maps a slot-fill node back to the node + prop that fills its slot', () => {
    const site = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['owner'] }),
            owner: makeNode({
              id: 'owner',
              moduleId: 'studio.instance',
              props: { callSiteProps: { icon: studioSlotValue('Home.tsx:12:9') } },
            }),
            'Home.tsx:12:9': makeNode({ id: 'Home.tsx:12:9', moduleId: 'base.icon' }),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, site)

    expect(indexes.slotOwnerBindings.get('Home.tsx:12:9')).toEqual([
      { pageId: 'page-a', ownerNodeId: 'owner', ownerModuleId: 'studio.instance', propKey: 'icon' },
    ])
  })

  it('clearNodeIndexes empties every map', () => {
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, sharedNodeSite())
    expect(indexes.nodeIdToPageIds.size).toBeGreaterThan(0)
    clearNodeIndexes(indexes)
    expect(indexes.nodeIdToPageIds.size).toBe(0)
    expect(indexes.textOriginKeyToCount.size).toBe(0)
    expect(indexes.inlineTailToCount.size).toBe(0)
    expect(indexes.classIdToNodeCount.size).toBe(0)
    expect(indexes.slotOwnerBindings.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Unit: applyNodeIndexPatch
// ---------------------------------------------------------------------------

describe('applyNodeIndexPatch', () => {
  it('adds a newly-inserted node id to exactly the touched page', () => {
    const pre = sharedNodeSite()
    const post = structuredClone(pre)
    post.pages[0]!.nodes['new-node'] = makeNode({ id: 'new-node', moduleId: 'base.text' })
    post.pages[0]!.nodes.root!.children.push('new-node')

    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })

    expect(indexes.nodeIdToPageIds.get('new-node')).toEqual(['page-a'])
    // Untouched page's shared mapping survives.
    expect([...(indexes.nodeIdToPageIds.get(SHARED_ID) ?? [])].sort()).toEqual(['page-a', 'page-b'])
  })

  it('deleting a shared node from ONE page never drops the OTHER page\'s mapping', () => {
    const pre = sharedNodeSite()
    const post = structuredClone(pre)
    delete post.pages[0]!.nodes[SHARED_ID]
    post.pages[0]!.nodes.root!.children = []

    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })

    expect(indexes.nodeIdToPageIds.get(SHARED_ID)).toEqual(['page-b'])
  })

  it('page deletion strips exactly that page\'s contributions, preserving a shared id on the survivor', () => {
    const pre = sharedNodeSite()
    const post = structuredClone(pre)
    post.pages = [post.pages[1]!]

    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), deletedPageIds: new Set(['page-a']) })

    expect(indexes.nodeIdToPageIds.get(SHARED_ID)).toEqual(['page-b'])
    expect(indexes.nodeIdToPageIds.get('root')).toEqual(['page-b'])
  })

  it('decrements textOrigin/inline-tail counts when the owning node is removed', () => {
    const origin = { rel: 'src/copy.ts', line: 1, col: 1 }
    const pre = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t1', 't2'] }),
            t1: makeNode({ id: 't1', moduleId: 'base.text', textOrigin: origin }),
            t2: makeNode({ id: 't2', moduleId: 'base.text', textOrigin: origin }),
          },
        }),
      ],
    })
    const post = structuredClone(pre)
    delete post.pages[0]!.nodes.t2
    post.pages[0]!.nodes.root!.children = ['t1']

    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    expect(indexes.textOriginKeyToCount.get(textOriginKey(origin))).toBe(2)

    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })
    expect(indexes.textOriginKeyToCount.get(textOriginKey(origin))).toBe(1)
  })

  it('re-indexes classIds on a SURVIVING node id — the id-set diff cannot see it', () => {
    // The landmine this facet exists to avoid: `classIds` changes on a node
    // that keeps its id, so the pre/post id-set diff every other facet relies
    // on reports "nothing entered, nothing left" and would leave the tally
    // permanently stale.
    const pre = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a'] }),
            a: makeNode({ id: 'a', classIds: ['hero'] }),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    expect(indexes.classIdToNodeCount.get('hero')).toBe(1)

    const post = structuredClone(pre)
    post.pages[0]!.nodes.a!.classIds = ['hero', 'pad']
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })
    expect(indexes.classIdToNodeCount.get('hero')).toBe(1)
    expect(indexes.classIdToNodeCount.get('pad')).toBe(1)

    // …and removing it again drops the key entirely rather than leaving a 0.
    const post2 = structuredClone(post)
    post2.pages[0]!.nodes.a!.classIds = []
    applyNodeIndexPatch(indexes, post, post2, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })
    expect(indexes.classIdToNodeCount.has('hero')).toBe(false)
    expect(indexes.classIdToNodeCount.has('pad')).toBe(false)
  })

  it('drops a deleted node\'s class contribution but keeps its twin\'s', () => {
    const pre = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
            a: makeNode({ id: 'a', classIds: ['hero'] }),
            b: makeNode({ id: 'b', classIds: ['hero'] }),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)

    const post = structuredClone(pre)
    delete post.pages[0]!.nodes.b
    post.pages[0]!.nodes.root!.children = ['a']
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })

    expect(indexes.classIdToNodeCount.get('hero')).toBe(1)
  })

  it('re-points a slot binding when the owner\'s sentinel changes, without touching another page\'s', () => {
    const ownerWith = (slotId: string) =>
      makeNode({
        id: 'owner',
        moduleId: 'studio.instance',
        props: { callSiteProps: { icon: studioSlotValue(slotId) } },
      })
    const pre = makeSite({
      pages: [
        makePage({
          id: 'page-a',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['owner'] }),
            owner: ownerWith('old-slot'),
          },
        }),
        makePage({
          id: 'page-b',
          nodes: {
            root2: makeNode({ id: 'root2', moduleId: 'base.body', children: ['owner'] }),
            owner: ownerWith('shared-slot'),
          },
        }),
      ],
    })
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    expect(indexes.slotOwnerBindings.get('old-slot')).toHaveLength(1)

    const post = structuredClone(pre)
    post.pages[0]!.nodes.owner!.props = { callSiteProps: { icon: studioSlotValue('new-slot') } }
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), pageIds: new Set(['page-a']) })

    expect(indexes.slotOwnerBindings.has('old-slot')).toBe(false)
    expect(indexes.slotOwnerBindings.get('new-slot')?.[0]?.pageId).toBe('page-a')
    // page-b was never marked; its binding is untouched.
    expect(indexes.slotOwnerBindings.get('shared-slot')?.[0]?.pageId).toBe('page-b')
  })

  it('marks.all falls back to a full rebuild', () => {
    const pre = sharedNodeSite()
    const post = makeSite({ pages: [makePage({ id: 'page-c', slug: 'new' })] })

    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    applyNodeIndexPatch(indexes, pre, post, { ...emptyDirtyMarks(), all: true })

    const expected = emptyIndexes()
    rebuildNodeIndexes(expected, post)
    expect(indexes.nodeIdToPageIds).toEqual(expected.nodeIdToPageIds)
  })

  it('is a no-op when marks name no touched or deleted pages', () => {
    const pre = sharedNodeSite()
    const indexes = emptyIndexes()
    rebuildNodeIndexes(indexes, pre)
    const before = new Map(indexes.nodeIdToPageIds)

    applyNodeIndexPatch(indexes, pre, pre, emptyDirtyMarks())

    expect(indexes.nodeIdToPageIds).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Store integration: the real editor store
// ---------------------------------------------------------------------------

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
    ...nodeIndexState(emptyIndexes()),
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('editor store node-index wiring', () => {
  beforeEach(freshStore)

  it('loadSite builds the index, many-valued for a shared node id', () => {
    useEditorStore.getState().loadSite(sharedNodeSite())
    const { _nodeIdToPageIds } = useEditorStore.getState()
    expect([...(_nodeIdToPageIds.get(SHARED_ID) ?? [])].sort()).toEqual(['page-a', 'page-b'])
  })

  it('insertNode adds the new id to the active page only', () => {
    useEditorStore.getState().loadSite(sharedNodeSite())
    useEditorStore.setState({ activePageId: 'page-a' })

    const newId = useEditorStore.getState().insertNode('base.text', {}, 'root')

    expect(useEditorStore.getState()._nodeIdToPageIds.get(newId)).toEqual(['page-a'])
  })

  it('deleteNode REFUSES a shared id outright, leaving both pages mapped', () => {
    // This asserted a per-page decrement until `struct-01` gave structural
    // edits a source target. `SHARED_ID` is `app/blog/layout.tsx:4:7` — route
    // chrome, one piece of source markup rendered by every page that uses the
    // layout. There is no edit that deletes it from page-a alone: rewriting
    // `layout.tsx` deletes it from page-b too. So `refuseStructuralEdit`
    // declines it BEFORE mutating, and the honest index outcome is that
    // nothing changed at all.
    //
    // The per-page decrement itself is still exercised — by `removePage` and
    // by the `applyNodeIndexPatch` unit tests above — it just can no longer
    // be reached through a delete, because that delete would have been a lie.
    useEditorStore.getState().loadSite(sharedNodeSite())
    useEditorStore.setState({ activePageId: 'page-a' })

    useEditorStore.getState().deleteNode(SHARED_ID)

    expect([...(useEditorStore.getState()._nodeIdToPageIds.get(SHARED_ID) ?? [])].sort())
      .toEqual(['page-a', 'page-b'])
    // And the node itself survives on both pages — a refusal is a no-op, not
    // a partial apply.
    const pages = useEditorStore.getState().site?.pages ?? []
    expect(pages.every((p) => p.nodes[SHARED_ID] !== undefined)).toBe(true)
  })

  it('duplicateNode on a node with a textOrigin increments the shared count', () => {
    const origin = { rel: 'src/copy.ts', line: 5, col: 2 }
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t1'] }),
              t1: makeNode({ id: 't1', moduleId: 'base.text', textOrigin: origin }),
            },
          }),
        ],
      }),
    )
    expect(useEditorStore.getState()._textOriginKeyToCount.get(textOriginKey(origin))).toBe(1)

    useEditorStore.getState().duplicateNode('t1')

    expect(useEditorStore.getState()._textOriginKeyToCount.get(textOriginKey(origin))).toBe(2)
  })

  it('undo/redo keep the index in lockstep with the restored site', () => {
    useEditorStore.getState().loadSite(sharedNodeSite())
    useEditorStore.setState({ activePageId: 'page-a' })

    const newId = useEditorStore.getState().insertNode('base.text', {}, 'root')
    expect(useEditorStore.getState()._nodeIdToPageIds.has(newId)).toBe(true)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState()._nodeIdToPageIds.has(newId)).toBe(false)
    // The shared id's mapping across both pages must still be intact after undo.
    expect([...(useEditorStore.getState()._nodeIdToPageIds.get(SHARED_ID) ?? [])].sort()).toEqual([
      'page-a',
      'page-b',
    ])

    useEditorStore.getState().redo()
    expect(useEditorStore.getState()._nodeIdToPageIds.get(newId)).toEqual(['page-a'])
  })

  it('deletePage strips the deleted page\'s contribution but keeps the survivor\'s', () => {
    useEditorStore.getState().loadSite(sharedNodeSite())

    useEditorStore.getState().deletePage('page-a')

    expect(useEditorStore.getState()._nodeIdToPageIds.get(SHARED_ID)).toEqual(['page-b'])
  })

  it('class assignment / removal keeps the usage tally true through undo and redo', () => {
    // The Selectors panel's "Used N times" badge and its Unused filter read
    // this tally directly (`_classIdToNodeCount`). Before store-01b both
    // rebuilt it from a full-site walk in a render body, once per keystroke.
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
              a: makeNode({ id: 'a', moduleId: 'base.text' }),
              b: makeNode({ id: 'b', moduleId: 'base.text' }),
            },
          }),
        ],
      }),
    )
    useEditorStore.setState({ activePageId: 'page-a' })
    const cls = useEditorStore.getState().createClass('hero')

    useEditorStore.getState().addNodeClass('a', cls.id)
    useEditorStore.getState().addNodeClass('b', cls.id)
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(2)

    useEditorStore.getState().removeNodeClass('b', cls.id)
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(1)

    // Undo the removal: b carries it again.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(2)
    // Redo it: back to one.
    useEditorStore.getState().redo()
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(1)
  })

  it('deleting a node decrements every class it carried; deleting the class zeroes it out', () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
              a: makeNode({ id: 'a', moduleId: 'base.text' }),
              b: makeNode({ id: 'b', moduleId: 'base.text' }),
            },
          }),
        ],
      }),
    )
    useEditorStore.setState({ activePageId: 'page-a' })
    const cls = useEditorStore.getState().createClass('hero')
    useEditorStore.getState().addNodeClass('a', cls.id)
    useEditorStore.getState().addNodeClass('b', cls.id)

    useEditorStore.getState().deleteNode('b')
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(1)

    // `deleteClasses` strips the id from every node on every page — a
    // surviving-node classIds edit, invisible to an id-set diff.
    useEditorStore.getState().deleteClass(cls.id)
    expect(useEditorStore.getState()._classIdToNodeCount.has(cls.id)).toBe(false)
  })

  it('duplicateNode carries the original\'s classes into the tally', () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a'] }),
              a: makeNode({ id: 'a', moduleId: 'base.text' }),
            },
          }),
        ],
      }),
    )
    useEditorStore.setState({ activePageId: 'page-a' })
    const cls = useEditorStore.getState().createClass('hero')
    useEditorStore.getState().addNodeClass('a', cls.id)
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(1)

    useEditorStore.getState().duplicateNode('a')
    expect(useEditorStore.getState()._classIdToNodeCount.get(cls.id)).toBe(2)
  })

  it('a prop keystroke leaves the class index untouched — same Map, no rebuild', () => {
    // The whole point of the index: typing into a prop must not rebuild it.
    // Mutative only mints a new Map when the Map is actually written to, so
    // identity-stability here IS the "no per-keystroke work" assertion.
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a'] }),
              a: makeNode({ id: 'a', moduleId: 'base.text', classIds: ['hero'] }),
            },
          }),
        ],
      }),
    )
    useEditorStore.setState({ activePageId: 'page-a' })
    const before = useEditorStore.getState()._classIdToNodeCount

    useEditorStore.getState().updateNodeProps('a', { text: 'h' })
    useEditorStore.getState().updateNodeProps('a', { text: 'he' })

    expect(useEditorStore.getState()._classIdToNodeCount).toBe(before)
    expect(useEditorStore.getState()._classIdToNodeCount.get('hero')).toBe(1)
  })

  it('loadSite wires the slot-owner reverse index that SlotFillNotice reads', () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['owner'] }),
              owner: makeNode({
                id: 'owner',
                moduleId: 'studio.instance',
                props: { callSiteProps: { icon: studioSlotValue('Home.tsx:12:9') } },
                children: ['Home.tsx:12:9'],
              }),
              'Home.tsx:12:9': makeNode({ id: 'Home.tsx:12:9', moduleId: 'base.icon' }),
            },
          }),
        ],
      }),
    )

    expect(lookupSlotOwner(useEditorStore.getState()._slotOwnerBindings, 'Home.tsx:12:9')).toMatchObject({
      ownerNodeId: 'owner',
      propKey: 'icon',
    })
    // A node that fills nobody's slot has no owner — the notice renders nothing.
    expect(lookupSlotOwner(useEditorStore.getState()._slotOwnerBindings, 'root')).toBeNull()
  })

  it('clearSite empties every index', () => {
    useEditorStore.getState().loadSite(sharedNodeSite())
    expect(useEditorStore.getState()._nodeIdToPageIds.size).toBeGreaterThan(0)

    useEditorStore.getState().clearSite()

    expect(useEditorStore.getState()._nodeIdToPageIds.size).toBe(0)
    expect(useEditorStore.getState()._textOriginKeyToCount.size).toBe(0)
    expect(useEditorStore.getState()._inlineTailToCount.size).toBe(0)
    expect(useEditorStore.getState()._classIdToNodeCount.size).toBe(0)
    expect(useEditorStore.getState()._slotOwnerBindings.size).toBe(0)
  })

  it('createSite rebuilds the index for the fresh site', () => {
    useEditorStore.getState().loadSite(sharedNodeSite())
    const created = useEditorStore.getState().createSite('Fresh Site')

    const { _nodeIdToPageIds } = useEditorStore.getState()
    expect(_nodeIdToPageIds.get(created.pages[0]!.rootNodeId)).toEqual([created.pages[0]!.id])
    // The old shared-layout entry is gone — this is a different site now.
    expect(_nodeIdToPageIds.has(SHARED_ID)).toBe(false)
  })
})
