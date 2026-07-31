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
import { fsCodemodAdapter, getStudioVendorCss, subscribeStudioVendorCss } from '../fsCodemodAdapter'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
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
      '/admin/api/studio/load': { dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {}, styleRules: {}, conditions: [], vendorCss: '' },
      '/admin/api/studio/framework': { framework: null },
      '/admin/api/studio/save': { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false },
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

  it('never ships a structured prop as an edit — there is no scalar to write', async () => {
    stubFetch()
    await loadThenResetCalls()

    // `<ActionSheet actions={[{ label }]}/>` reaches the document with a real
    // array (see `ParsedPropValue`). `setJsxProp` writes a scalar initializer,
    // so shipping this would either throw or bake `actions="[object Object]"`
    // over the source array. The only edit that may leave here is `title`.
    const site = makeSite({
      pages: [
        makePage({
          rootNodeId: 'root',
          nodes: {
            root: makeNode({
              id: 'pages/Device.tsx:9:7',
              moduleId: 'alm.ActionSheet',
              props: {
                title: 'Pick a device',
                actions: [{ label: 'This device' }, { label: 'Another device' }],
              },
            }),
          },
        }),
      ],
    })

    await fsCodemodAdapter.saveSite(site)

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body as { edits: Array<{ kind: string; prop?: string }> }
    expect(body.edits.map((e) => e.prop)).toEqual(['title'])
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

  // ─── Reload gating ────────────────────────────────────────────────────────
  //
  // A studio reload re-parses the workspace from disk and replaces the whole
  // document. That is correct when a write actually landed and moved line
  // numbers (stale `line:col` ids) or rewrote a shared component (stale sibling
  // instances) — and destructive when NOTHING landed, because the reload then
  // overwrites the user's in-memory edit with the unchanged source. The symptom
  // was an edit reverting itself ~2s after being typed: `setJsxText` refuses
  // prop-bound text (`<p>{title}</p>`), the server reported
  // `written: 0, skipped: 1, sharedComponents: true`, and the client reloaded
  // over the top of it anyway.
  describe('reload is gated on a write actually landing', () => {
    function editedSite() {
      return makeSite({
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
    }

    /** Counts `CMS_SITE_RELOAD_EVENT` dispatches while `run` executes. */
    async function countReloads(run: () => Promise<void>): Promise<number> {
      let reloads = 0
      const onReload = () => { reloads += 1 }
      window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      try {
        await run()
      } finally {
        window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      }
      return reloads
    }

    it('does NOT reload when every edit was skipped, even with sharedComponents set', async () => {
      stubFetch({
        '/admin/api/studio/save': {
          ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: true,
        },
      })
      await loadThenResetCalls()

      const reloads = await countReloads(() => fsCodemodAdapter.saveSite(editedSite()))

      // Nothing reached disk, so the document still matches the files. Reloading
      // here would replace the user's edit with the unchanged source.
      expect(reloads).toBe(0)
    })

    it('does NOT reload when nothing was written and a line count still shifted', async () => {
      // `shifted` is derived from a line-count delta, which an unrelated
      // concurrent write could also produce. With no write of our own there are
      // no ids of ours to re-derive.
      stubFetch({
        '/admin/api/studio/save': {
          ok: true, written: 0, skipped: 2, shifted: true, sharedComponents: false,
        },
      })
      await loadThenResetCalls()

      const reloads = await countReloads(() => fsCodemodAdapter.saveSite(editedSite()))

      expect(reloads).toBe(0)
    })

    it('DOES reload when a write landed and shifted line numbers', async () => {
      stubFetch({
        '/admin/api/studio/save': {
          ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false,
        },
      })
      await loadThenResetCalls()

      const reloads = await countReloads(() => fsCodemodAdapter.saveSite(editedSite()))

      // Every `line:col` id below the write is now stale — re-parse is required.
      expect(reloads).toBe(1)
    })

    it('DOES reload when a write landed on a shared component', async () => {
      stubFetch({
        '/admin/api/studio/save': {
          ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: true,
        },
      })
      await loadThenResetCalls()

      const reloads = await countReloads(() => fsCodemodAdapter.saveSite(editedSite()))

      // The component's own file changed, so every other instance on the board
      // is showing a stale value.
      expect(reloads).toBe(1)
    })

    it('does NOT reload on an ordinary in-place write', async () => {
      stubFetch({
        '/admin/api/studio/save': {
          ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false,
        },
      })
      await loadThenResetCalls()

      const reloads = await countReloads(() => fsCodemodAdapter.saveSite(editedSite()))

      expect(reloads).toBe(0)
    })
  })

  // ─── WS-2.3 — vendor CSS reactive store ────────────────────────────────────
  describe('vendor CSS (WS-2.3) — reactive external store', () => {
    it('exposes the loaded vendorCss via getStudioVendorCss()', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {},
          styleRules: {}, conditions: [], vendorCss: '.btn--primary { color: hotpink }',
        },
      })

      await fsCodemodAdapter.loadSite()

      expect(getStudioVendorCss()).toBe('.btn--primary { color: hotpink }')
    })

    it('notifies subscribers when a fresh load changes the value, and dedupes a same-value load', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {},
          styleRules: {}, conditions: [], vendorCss: '.a { color: red }',
        },
      })
      await fsCodemodAdapter.loadSite()

      let notifications = 0
      const unsubscribe = subscribeStudioVendorCss(() => { notifications += 1 })

      // Same value again — the store must not notify (ProjectCssInjector
      // shouldn't re-inject its <style> tag on every unrelated reload).
      await fsCodemodAdapter.loadSite()
      expect(notifications).toBe(0)

      // A genuinely different value — must notify exactly once.
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {},
          styleRules: {}, conditions: [], vendorCss: '.b { color: blue }',
        },
      })
      await fsCodemodAdapter.loadSite()
      expect(notifications).toBe(1)
      expect(getStudioVendorCss()).toBe('.b { color: blue }')

      unsubscribe()
    })
  })
})
