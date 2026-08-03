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
 *
 * mcp-tooling's live-reload bridge (`fetchStudioPagesById` in
 * `../studioLiveReloadFetch.ts`) is a deliberate exception to "a save never
 * reloads" above, and a different trigger entirely from the write-loop this
 * file guards against: it fires only in response to an EXPLICIT, externally
 * triggered server write (an MCP tool call), never as a reaction to this
 * client's own save completing, and it never calls saveSite itself — the
 * "targeted reload" block below proves exactly that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fsCodemodAdapter, getStudioVendorCss, subscribeStudioVendorCss } from '../fsCodemodAdapter'
import { fetchStudioPagesById } from '../studioLiveReloadFetch'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
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
      '/admin/api/studio/load': { dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [] },
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
      // `/admin/api/studio/load` is read as an NDJSON stream (WS-5.5,
      // `?stream=1` — see `fsCodemodAdapter.ts`'s `loadSite`): one meta line
      // (everything but `pages`) followed by one `kind: 'page'` line per
      // page. Test call sites above still pass the flat, pre-streaming
      // shape — translate it here so every existing `stubFetch({ ... })`
      // call keeps working unchanged.
      if (path === '/admin/api/studio/load') {
        const { pages, ...meta } = body as { pages: unknown[]; [k: string]: unknown }
        const lines = [
          // `styleRuleSources` (panel-02, the `StyleRule.id → (file, selector,
          // pos)` map CSS write-back needs) is REQUIRED on the meta line, so a
          // fixture without it fails the whole union with the unhelpful
          // `<root>: Expected union value`. Defaulted here rather than in each
          // fixture, for the same reason the flat→NDJSON translation lives
          // here: a call site that does not care about CSS sources should not
          // have to name the field. A fixture that does care still overrides.
          { kind: 'meta', styleRuleSources: {}, ...meta, pageCount: pages.length },
          ...pages.map((page) => ({ kind: 'page', page })),
        ]
        return new Response(
          lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        )
      }
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

  // ─── mcp-tooling — the live-reload bridge (targeted reload + baseline resync) ──
  describe('fetchStudioPagesById (mcp-tooling live-reload bridge) — targeted reload + baseline resync', () => {
    function loadResponse(pages: unknown[], extra: Record<string, unknown> = {}) {
      return {
        dir: '/tmp/studio-test', projectName: 'studio-test', pages,
        componentSources: {}, styleRules: {}, conditions: [], vendorCss: '',
        trust: 'static', paletteHiddenModuleIds: [], ...extra,
      }
    }

    function homePage(text: string) {
      return makePage({
        id: 'home',
        slug: 'index',
        title: 'Home',
        rootNodeId: 'root',
        nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text } }) },
      })
    }

    it('requests only the given pageIds via ?pageIds= and patches just that page into the store', async () => {
      stubFetch({ '/admin/api/studio/load': loadResponse([homePage('Original')]) })
      const site = await fsCodemodAdapter.loadSite()
      useEditorStore.getState().loadSite(site!)
      calls = []

      stubFetch({ '/admin/api/studio/load': loadResponse([homePage('Edited by agent')]) })
      const { pages, missingPageIds } = await fetchStudioPagesById(['home'])
      useEditorStore.getState().patchPages({ pages, removedPageIds: missingPageIds })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toContain('/admin/api/studio/load')
      expect(calls[0]!.url).toContain('pageIds=home')
      const patched = useEditorStore.getState().site!.pages[0]!
      expect(Object.values(patched.nodes)[0]!.props!.text).toBe('Edited by agent')
    })

    it('maps meta.missingPageIds to removedPageIds — a requested page deleted by the very edit that triggered the reload', async () => {
      stubFetch({
        '/admin/api/studio/load': loadResponse([
          homePage('Original'),
          makePage({ id: 'about', slug: 'about', title: 'About' }),
        ]),
      })
      const site = await fsCodemodAdapter.loadSite()
      useEditorStore.getState().loadSite(site!)

      stubFetch({ '/admin/api/studio/load': loadResponse([], { missingPageIds: ['about'] }) })
      const { pages, missingPageIds } = await fetchStudioPagesById(['about'])
      useEditorStore.getState().patchPages({ pages, removedPageIds: missingPageIds })

      expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual(['home'])
    })

    it('CRITICAL — resyncs the save-diff baseline: the very next save does not re-send the value the reload just applied', async () => {
      stubFetch({ '/admin/api/studio/load': loadResponse([homePage('Original')]) })
      const initialSite = await fsCodemodAdapter.loadSite()
      calls = []

      // Simulates the agent having already written "Edited by agent" straight
      // to the .tsx via studio_apply_edits — the filtered reload reads it back.
      stubFetch({ '/admin/api/studio/load': loadResponse([homePage('Edited by agent')]) })
      const { pages } = await fetchStudioPagesById(['home'])
      calls = []

      // Re-using `initialSite`'s own `settings.framework` object (not a fresh
      // `makeSite(...)` default) so this save's ONLY variable is the reloaded
      // page content — a framework-shape mismatch would add an unrelated
      // `/framework` POST and falsely fail the "zero calls" assertion below.
      await fsCodemodAdapter.saveSite({ ...initialSite!, pages })

      // If the baseline had NOT been resynced, this would diff "Edited by
      // agent" (now on screen) against the STALE "Original" baseline and ship
      // a redundant `prop` edit — exactly the regression this test guards.
      expect(calls).toHaveLength(0)
    })

    it('GATE — a targeted reload never calls /save and never dispatches the full-reload event (no write-loop cascade)', async () => {
      stubFetch({ '/admin/api/studio/load': loadResponse([homePage('Original')]) })
      const site = await fsCodemodAdapter.loadSite()
      useEditorStore.getState().loadSite(site!)
      calls = []

      stubFetch({ '/admin/api/studio/load': loadResponse([homePage('Edited by agent')]) })
      let reloadEvents = 0
      const onReload = () => { reloadEvents += 1 }
      window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      try {
        const { pages, missingPageIds } = await fetchStudioPagesById(['home'])
        useEditorStore.getState().patchPages({ pages, removedPageIds: missingPageIds })
      } finally {
        window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      }

      expect(calls.some((c) => c.url.startsWith('/admin/api/studio/save'))).toBe(false)
      expect(reloadEvents).toBe(0)
      expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)
    })
  })

  // ─── WS-2.3 — vendor CSS reactive store ────────────────────────────────────
  describe('vendor CSS (WS-2.3) — reactive external store', () => {
    it('exposes the loaded vendorCss via getStudioVendorCss()', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test', pages: [], componentSources: {},
          styleRules: {}, conditions: [], vendorCss: '.btn--primary { color: hotpink }',
          trust: 'static', paletteHiddenModuleIds: [],
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
          trust: 'static', paletteHiddenModuleIds: [],
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
          trust: 'static', paletteHiddenModuleIds: [],
        },
      })
      await fsCodemodAdapter.loadSite()
      expect(notifications).toBe(1)
      expect(getStudioVendorCss()).toBe('.b { color: blue }')

      unsubscribe()
    })
  })
})
