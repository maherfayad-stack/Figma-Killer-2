/**
 * fsCodemodAdapter — write-loop safety + framework-settings sync.
 *
 * Phase 5B ("Autosave cadence + write-loop safety") asked whether a completed
 * studio source-writeback can re-enter as a "file changed" reload that
 * re-dirties the store and triggers another save — a write→watch→write loop.
 *
 * The answer, confirmed here at the adapter boundary: `saveSite` issues at
 * most TWO outbound requests — `POST /admin/api/studio/save` (per-node
 * prop/text/style edits, only when there are any) and `POST
 * /admin/api/studio/framework` (only when `site.settings.framework` changed
 * since the last load/save) — and never itself calls `loadSite` / GETs
 * `/admin/api/studio/load`. There is no watcher anywhere in this codebase for
 * `studio-workspace/pages/**` — Vite's dev-server module graph never imports
 * those `.tsx` files (they're read via `node:fs` inside the Bun server, not
 * `import`ed), and nothing dispatches `CMS_SITE_RELOAD_EVENT` after a studio
 * save (grep confirms its only dispatchers are `requestCmsSiteReload` call
 * sites — manual save-then-reload and plugin install, both explicit
 * user-triggered actions). So a save completing cannot, by construction,
 * cause a reload that re-arms the autosave loop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fsCodemodAdapter } from '../fsCodemodAdapter'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'

describe('fsCodemodAdapter — write-loop safety + framework sync', () => {
  let originalFetch: typeof globalThis.fetch
  let calls: Array<{ url: string; method: string; body: unknown }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(responses: Record<string, unknown> = {}) {
    const defaults: Record<string, unknown> = {
      '/admin/api/studio/load': { dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {} },
      '/admin/api/studio/framework': { framework: null },
      '/admin/api/studio/save': { ok: true, written: 1, skipped: 0, shifted: false },
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      const path = url.split('?')[0]
      const method = init?.method ?? 'GET'
      // POST /admin/api/studio/framework echoes the posted framework back,
      // matching the real endpoint's `{ ok, framework }` response shape.
      if (path === '/admin/api/studio/framework' && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        return new Response(JSON.stringify({ ok: true, framework: body.framework }), { status: 200 })
      }
      const body = responses[path] ?? defaults[path]
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
  }

  /** Runs `loadSite()` (with framework: null, i.e. nothing persisted yet) and clears the resulting calls, so `lastSyncedFrameworkJson` is initialized to the SAME default `settings.framework` shape `makeSite()` fixtures use — isolating each save-time assertion below to just what that test changes. */
  async function loadThenResetCalls(): Promise<void> {
    await fsCodemodAdapter.loadSite()
    calls = []
  }

  it('issues exactly ONE request — a POST to /admin/api/studio/save — when only node props changed', async () => {
    stubFetch()
    await loadThenResetCalls()

    // A source-backed node id (`relFile:line:col`) with one literal prop
    // edit, so the adapter has something to ship. `settings` is omitted so
    // the fixture's default framework matches what `loadSite` just synced.
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

  it('makes NO request when there are no source-backed edits and the framework is unchanged', async () => {
    stubFetch()
    await loadThenResetCalls()

    // Synthetic node ids (e.g. the default `root`/`index:body` shape) don't
    // match the `relFile:line:col` pattern, so nothing ships; `settings` is
    // omitted so the framework matches what `loadSite` just synced.
    const site = makeSite({
      pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'root' }) } })],
    })

    await fsCodemodAdapter.saveSite(site)

    expect(calls).toHaveLength(0)
  })

  it('POSTs framework settings when only the framework changed — no node edits at all', async () => {
    stubFetch()
    await loadThenResetCalls()

    const site = makeSite({
      pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'root' }) } })],
    })
    site.settings.framework = {
      ...site.settings.framework,
      colors: { tokens: [{ id: 't1', category: 'brand', slug: 'brand-500', lightValue: '#4f46e5', darkValue: '#4f46e5', darkModeEnabled: false, generateUtilities: { text: true, background: true, border: true, fill: false }, generateTransparent: false, generateShades: { enabled: false, count: 5 }, generateTints: { enabled: false, count: 5 }, order: 0, createdAt: 0, updatedAt: 0 }] },
    }

    await fsCodemodAdapter.saveSite(site)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: '/admin/api/studio/framework', method: 'POST' })
    expect((calls[0].body as { framework: { colors: { tokens: unknown[] } } }).framework.colors.tokens).toHaveLength(1)
  })

  it('sends BOTH requests, save then framework, when both changed in the same save', async () => {
    stubFetch()
    await loadThenResetCalls()

    const site = makeSite({
      pages: [
        makePage({
          rootNodeId: 'root',
          nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hi' } }) },
        }),
      ],
    })
    site.settings.framework = {
      ...site.settings.framework,
      colors: { tokens: [{ id: 't1', category: 'brand', slug: 'brand-500', lightValue: '#4f46e5', darkValue: '#4f46e5', darkModeEnabled: false, generateUtilities: { text: true, background: true, border: true, fill: false }, generateTransparent: false, generateShades: { enabled: false, count: 5 }, generateTints: { enabled: false, count: 5 }, order: 0, createdAt: 0, updatedAt: 0 }] },
    }

    await fsCodemodAdapter.saveSite(site)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ url: '/admin/api/studio/save', method: 'POST' })
    expect(calls[1]).toMatchObject({ url: '/admin/api/studio/framework', method: 'POST' })
  })
})
