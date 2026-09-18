/**
 * Deleting a page takes its flows with it.
 *
 * `prunePrototypeLinks` and the `prune` op both existed from Phase 1b and
 * nothing called them, so a link to a deleted page simply drew nothing and the
 * inspector listed it pointing at "Deleted page". The caller has to be the
 * CLIENT: `prune` carries the list of pages that still exist, and the server
 * cannot enumerate those without parsing the project — which is exactly the
 * work the route exists to avoid.
 *
 * What is pinned here is the contract around that call, because each half of it
 * is a decision rather than an implementation detail: which pages the op names,
 * when no request is made at all, and that a failure does not surface as an
 * error on an operation that succeeded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { pruneLinksForDeletedPage } from '@site/studio/prototypePrune'
import type { PrototypeLink } from '@core/studio-prototype'

interface Posted {
  url: string
  body: { dir?: string; op: { kind: string; pageIds?: string[] } }
}

const originalFetch = globalThis.fetch
let posted: Posted[] = []
/** The links the fake server answers with — the merged file a real one returns. */
let served: PrototypeLink[] = []

function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/admin/api/studio/prototype') && init?.method === 'POST') {
      posted.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(
        JSON.stringify({ ok: true, changed: true, prototype: { version: 1, links: served } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // Every other call a delete makes (the page's own source delete) succeeds
    // quietly — this test is about the prune, not about the file.
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

const state = () => useEditorStore.getState()

/** Let the fire-and-forget prune's fetch, and the adopt that follows it, run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function link(id: string, sourcePageId: string, targetPageId: string | null): PrototypeLink {
  return {
    id,
    source: {
      pageId: sourcePageId,
      node: { nodeId: 'n', indexPath: [0], moduleId: 'base.button', textSnippet: 'Go' },
    },
    trigger: { kind: 'click' },
    action: targetPageId ? 'navigate' : 'back',
    targetPageId,
    ...(targetPageId ? { transition: 'slide-left' as const } : {}),
  }
}

/** A three-page site, with `links` loaded as if read from disk. */
function site(links: PrototypeLink[]): { ids: string[] } {
  const created = state().createSite('Flows')
  const home = created.pages[0]!
  const second = state().addPage('Second', 'second')
  const third = state().addPage('Third', 'third')
  const ids = [home.id, second.id, third.id]
  const resolved = links.map((l, index) => ({
    ...l,
    source: { ...l.source, pageId: ids[Number(l.source.pageId)] ?? l.source.pageId },
    targetPageId: l.targetPageId === null ? null : (ids[Number(l.targetPageId)] ?? l.targetPageId),
    id: `link-${index}`,
  }))
  useEditorStore.setState({ prototype: { version: 1, links: resolved }, prototypeLoaded: true })
  return { ids }
}

beforeEach(() => {
  posted = []
  served = []
  globalThis.fetch = fakeFetch()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    prototype: { version: 1, links: [] },
    prototypeLoaded: false,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('deleting a page prunes its links', () => {
  it('names exactly the pages that still exist', async () => {
    // Indexes into the three-page site — `site()` maps them onto real ids.
    const { ids } = site([link('a', '0', '1')])
    state().deletePage(ids[1]!)
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0]!.body.op.kind).toBe('prune')
    expect(posted[0]!.body.op.pageIds).toEqual([ids[0]!, ids[2]!])
  })

  it('prunes a link pointing AT the deleted page, not only one starting from it', async () => {
    // Both halves of a link name a page, and only one of them is the source
    // whose `NodeHint` re-resolution would have noticed anything.
    const { ids } = site([link('a', '0', '1')])
    served = []
    state().deletePage(ids[1]!)
    await settle()

    expect(posted).toHaveLength(1)
    expect(state().prototype.links).toEqual([])
  })

  it('makes no request when nothing named the deleted page', async () => {
    // A project with no prototype must not pay a round trip per page delete,
    // and an op that changes nothing is a write the file does not need.
    const { ids } = site([link('a', '0', '2')])
    state().deletePage(ids[1]!)
    await settle()

    expect(posted).toHaveLength(0)
  })

  it('makes no request when there would be no pages left to name', async () => {
    // The server refuses an empty `prune` — it is indistinguishable from a
    // caller that failed to load its pages, and obeying it would wipe every
    // flow in the project. So asking would be asking for a 400 on purpose.
    //
    // Driven through the action rather than `deletePage`, which refuses to
    // remove the last page in a site at all: the guard has to hold for any
    // caller, not only the one that cannot reach it today.
    const created = state().createSite('Only')
    const only = created.pages[0]!
    useEditorStore.setState({
      prototype: { version: 1, links: [link('a', only.id, null)] },
      prototypeLoaded: true,
    })

    expect(await pruneLinksForDeletedPage(state().prototype.links, only.id, [])).toBeNull()

    expect(posted).toHaveLength(0)
    expect(state().prototype.links).toHaveLength(1)
  })

  it('does not report a failed prune as a failed delete', async () => {
    const { ids } = site([link('a', '0', '1')])
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 500 })) as typeof globalThis.fetch

    // The page IS deleted; a red box about the flow file would be noise on an
    // operation that succeeded.
    expect(() => state().deletePage(ids[1]!)).not.toThrow()
    await settle()
    expect(state().site!.pages.map((page) => page.id)).toEqual([ids[0]!, ids[2]!])
  })
})
