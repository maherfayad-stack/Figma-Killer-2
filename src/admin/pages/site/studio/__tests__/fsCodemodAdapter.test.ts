/**
 * fsCodemodAdapter — write-loop safety.
 *
 * Phase 5B ("Autosave cadence + write-loop safety") asked whether a completed
 * studio source-writeback can re-enter as a "file changed" reload that
 * re-dirties the store and triggers another save — a write→watch→write loop.
 *
 * The answer, confirmed here at the adapter boundary: `saveSite` issues
 * exactly ONE outbound request (the `POST /admin/api/studio/save` batch) and
 * never itself calls `loadSite` / GETs `/admin/api/studio/load`. There is no
 * watcher anywhere in this codebase for `studio-workspace/pages/**` — Vite's
 * dev-server module graph never imports those `.tsx` files (they're read via
 * `node:fs` inside the Bun server, not `import`ed), and nothing dispatches
 * `CMS_SITE_RELOAD_EVENT` after a studio save (grep confirms its only
 * dispatchers are `requestCmsSiteReload` call sites — manual save-then-reload
 * and plugin install, both explicit user-triggered actions). So a save
 * completing cannot, by construction, cause a reload that re-arms the
 * autosave loop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fsCodemodAdapter } from '../fsCodemodAdapter'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'

describe('fsCodemodAdapter.saveSite — write-loop safety', () => {
  let originalFetch: typeof globalThis.fetch
  let calls: Array<{ url: string; method: string; body: unknown }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(response: unknown = { ok: true, written: 1, skipped: 0, shifted: false }) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify(response), { status: 200 })
    }) as typeof fetch
  }

  it('issues exactly ONE request — a POST to /admin/api/studio/save — and never re-loads', async () => {
    stubFetch()

    // A source-backed node id (`relFile:line:col`) with one literal prop
    // edit, so the adapter has something to ship.
    const site = makeSite({
      pages: [
        makePage({
          rootNodeId: 'root',
          nodes: {
            root: makeNode({
              id: 'pages/Home.tsx:3:1',
              moduleId: 'base.text',
              props: { text: 'Hello' },
            }),
          },
        }),
      ],
    })

    await fsCodemodAdapter.saveSite(site)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: '/admin/api/studio/save', method: 'POST' })
    // No GET to the load endpoint — a save never re-reads the workspace.
    expect(calls.some((c) => c.url === '/admin/api/studio/load')).toBe(false)
  })

  it('makes NO request when there are no source-backed edits', async () => {
    stubFetch()

    // Synthetic node ids (e.g. the default `root`/`index:body` shape) don't
    // match the `relFile:line:col` pattern, so nothing ships.
    const site = makeSite({
      pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'root' }) } })],
    })

    await fsCodemodAdapter.saveSite(site)

    expect(calls).toHaveLength(0)
  })
})
