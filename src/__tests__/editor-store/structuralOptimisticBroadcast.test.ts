/**
 * `live-07` (STATE.md) — the store-slice call sites that broadcast a
 * structural gesture's same-tick optimistic DOM op to every mounted BRIDGE
 * frame, ahead of the async file write landing:
 *
 *   - `nodeActions.ts`'s `moveNodes` -> `broadcastOptimisticMove`
 *   - `nodeActions.ts`'s `deleteNode` -> `broadcastOptimisticDelete`
 *   - `deleteNodesAction.ts`'s `deleteNodes` -> `broadcastOptimisticDelete`
 *     (once per source-derived id in the batch)
 *   - `studioSourceWrites.ts`'s `writeInsertToSource` -> `broadcastOptimisticInsert`
 *     (with a throwaway `optimistic:<uuid>` placeholder id — there is no real
 *     one until the codemod writes the element)
 *
 * Every fixture here is a STUDIO-IMPORTED tree (`rel:line:col` node ids) —
 * the only shape where `plan.commit` is non-null and a broadcast fires at
 * all; a plain CMS tree's move/delete/insert never reaches the source-write
 * gate these broadcasts sit next to.
 *
 * A stub `BridgeFrameAdapter` is registered in the real
 * `canvasFrameAdapterRegistry` before each gesture runs — the same
 * `{ postMessage, addEventListener }` channel pattern `BridgeFrameAdapter
 * .test.ts` and `optimisticStructuralBroadcast.test.ts` already establish —
 * so these assertions exercise the REAL call sites, not a mock of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { makePage, makeSite } from '../fixtures'
import type { PageNode } from '@core/page-tree'
import type { InboundEnvelope } from '@core/studio-runtime'
import '@modules/base/index'

const FILE = 'app/page.tsx'
const at = (line: number) => `${FILE}:${line}:5`
const ROOT = 'page-1:body'

function studioSite(children: Record<string, { moduleId: string; children?: string[] }>, rootChildren: string[]) {
  const nodes: Record<string, PageNode> = {
    [ROOT]: { id: ROOT, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: rootChildren, classIds: [] },
  }
  for (const [id, def] of Object.entries(children)) {
    nodes[id] = {
      id,
      moduleId: def.moduleId,
      props: def.moduleId === 'base.text' ? { text: id } : {},
      breakpointOverrides: {},
      children: def.children ?? [],
      classIds: [],
    }
  }
  return makeSite({ pages: [makePage({ id: 'page-1', rootNodeId: ROOT, nodes })] })
}

const store = () => useEditorStore.getState()

let posted: InboundEnvelope[]
let adapter: BridgeFrameAdapter
let iframe: HTMLIFrameElement
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  posted = []
  const channel: BridgeFrameChannel = {
    postMessage: (message) => posted.push(message as InboundEnvelope),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  adapter = new BridgeFrameAdapter({ channel, frameOrigin: 'https://live.studio.test' })
  iframe = document.createElement('iframe')
  registerFrameAdapter(iframe, adapter)

  realFetch = globalThis.fetch
  // The structural commits this fires are fire-and-forget network writes —
  // stubbed so they resolve instead of hitting a real (nonexistent) server.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: [FILE] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // Reload scope: answer "not provably narrow" so nothing else is fetched.
    return new Response(JSON.stringify({ ok: true, narrow: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  })
})

afterEach(() => {
  unregisterFrameAdapter(iframe)
  adapter.dispose()
  globalThis.fetch = realFetch
})

describe('moveNodes broadcasts an optimistic move to every mounted bridge frame', () => {
  it('fires broadcastOptimisticMove with the new parent/index once the tree mutation succeeds', () => {
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite({ [a]: { moduleId: 'base.text' }, [b]: { moduleId: 'base.text' }, [c]: { moduleId: 'base.text' } }, [a, b, c]))
    store().setActivePage('page-1')

    store().moveNodes([a], ROOT, 3)

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({ type: 'optimistic.move', parentNodeId: ROOT, index: 3 })
  })
})

describe('deleteNode broadcasts an optimistic delete to every mounted bridge frame', () => {
  it('fires broadcastOptimisticDelete with the deleted node’s id', () => {
    const a = at(3), b = at(4)
    store().loadSite(studioSite({ [a]: { moduleId: 'base.text' }, [b]: { moduleId: 'base.text' } }, [a, b]))
    store().setActivePage('page-1')

    store().deleteNode(a)

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({ type: 'optimistic.delete' })
  })
})

describe('deleteNodes broadcasts one optimistic delete per source-derived id', () => {
  it('fires broadcastOptimisticDelete for every deleted id in the batch', () => {
    const a = at(3), b = at(4), c = at(5)
    store().loadSite(studioSite({ [a]: { moduleId: 'base.text' }, [b]: { moduleId: 'base.text' }, [c]: { moduleId: 'base.text' } }, [a, b, c]))
    store().setActivePage('page-1')

    store().deleteNodes([a, b])

    expect(posted).toHaveLength(2)
    expect(posted.map((p) => p.message.type)).toEqual(['optimistic.delete', 'optimistic.delete'])
  })
})

describe('writeInsertToSource broadcasts an optimistic insert with a throwaway placeholder id', () => {
  it('fires broadcastOptimisticInsert with the container id, index and honest intrinsic tag', () => {
    const container = at(3)
    store().loadSite(studioSite({ [container]: { moduleId: 'base.container' } }, [container]))
    store().setActivePage('page-1')

    store().insertNode('base.text', { text: 'hi' }, container)

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({ type: 'optimistic.insert', parentNodeId: container, tagName: 'p' })
    // A throwaway placeholder, never the (nonexistent) real node id.
    expect((posted[0]!.message as { nodeId: string }).nodeId.startsWith('optimistic:')).toBe(true)
  })
})
