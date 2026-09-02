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
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
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
          // pos)` map CSS write-back needs) and `authoredCss` (`board-27`'s
          // raw-CSS byte-fidelity fix) are REQUIRED on the meta line, so a
          // fixture without either fails the whole union with the unhelpful
          // `<root>: Expected union value`. Defaulted here rather than in each
          // fixture, for the same reason the flat→NDJSON translation lives
          // here: a call site that does not care about CSS sources/raw CSS
          // should not have to name the field. A fixture that does care still
          // overrides.
          { kind: 'meta', styleRuleSources: {}, authoredCss: '', ...meta, pageCount: pages.length },
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

  // ─── E1 (`STUDIO-FIGMA-PARITY-PLAN.md` 0.1) — save-diff baseline advances after a landed write ──
  //
  // Before the fix, `loadedValues` (the save-diff baseline) was reset ONLY on
  // a full `loadSite()` and never advanced by an ordinary, non-reloading
  // save. Repro: edit a value, autosave writes it, undo reverts the in-memory
  // tree back to the AS-LOADED value — which now equals the never-advanced
  // baseline — so the next autosave's diff sees "no change" and never POSTs,
  // leaving the pre-undo value on disk forever while the UI reports "Saved."
  describe('save-diff baseline advances after a landed write (E1)', () => {
    function siteWithText(text: string) {
      return makeSite({
        pages: [
          makePage({
            rootNodeId: 'root',
            nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text } }) },
          }),
        ],
      })
    }

    /**
     * Whether `base.text`'s `text` prop ships as a `kind: 'text'` edit or a
     * `kind: 'prop'` edit depends on `registry.get('base.text')?.inlineTextEdit`
     * having been populated — a module-level side effect of some OTHER test
     * file importing `@modules/base/index` earlier in the SAME process, so it
     * is order-dependent across the whole `bun test` run, not just this file.
     * Read whichever field carries the value, independent of which kind won.
     */
    function shippedTextValue(edit: { kind: string; text?: unknown; value?: unknown }): unknown {
      return edit.kind === 'text' ? edit.text : edit.value
    }

    it('CRITICAL — an undo back to the as-loaded value still fires a reverting POST on the next save', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hell' } }) } })],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
        // written:1, skipped:0 — the ordinary "in-place write" shape, so this
        // scenario never hits the reload branch and the baseline advance is
        // the ONLY mechanism that can keep the second save honest.
        '/admin/api/studio/save': { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false },
      })
      await loadThenResetCalls()

      // Simulates the user typing "Hell" -> "Hello", then autosave firing.
      await fsCodemodAdapter.saveSite(siteWithText('Hello'))
      expect(calls).toHaveLength(1)
      const firstBody = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: unknown; value?: unknown }> }
      expect(firstBody.edits).toHaveLength(1)
      expect(firstBody.edits[0]!.nodeId).toBe('pages/Home.tsx:3:1')
      expect(shippedTextValue(firstBody.edits[0]!)).toBe('Hello')
      calls = []

      // Simulates Ctrl+Z: the in-memory tree reverts to the ORIGINAL,
      // as-loaded value. No reload happened (written:1 but shifted/
      // sharedComponents both false), so if the baseline were still stuck at
      // "Hell" (the pre-fix bug), this diff would see "current === baseline"
      // and skip the POST — silently leaving "Hello" on disk forever.
      await fsCodemodAdapter.saveSite(siteWithText('Hell'))

      expect(calls).toHaveLength(1)
      const secondBody = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: unknown; value?: unknown }> }
      expect(secondBody.edits).toHaveLength(1)
      expect(secondBody.edits[0]!.nodeId).toBe('pages/Home.tsx:3:1')
      expect(shippedTextValue(secondBody.edits[0]!)).toBe('Hell')
    })

    it('does NOT advance the baseline for a batch with an unexplained skip, so a stale-id failure keeps re-attempting instead of silently adopting the unwritten value', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hell' } }) } })],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
        // written:0, skipped:1 — the edit never reached disk.
        '/admin/api/studio/save': { ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: false },
      })
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(siteWithText('Hello'))
      calls = []

      // The tree still reads "Hello" (nothing reverted) — if the baseline had
      // been wrongly advanced to "Hello" despite the skip, this second save
      // would see no diff and skip the retry.
      await fsCodemodAdapter.saveSite(siteWithText('Hello'))

      expect(calls).toHaveLength(1)
      const body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: unknown; value?: unknown }> }
      expect(body.edits).toHaveLength(1)
      expect(body.edits[0]!.nodeId).toBe('pages/Home.tsx:3:1')
      expect(shippedTextValue(body.edits[0]!)).toBe('Hello')
    })
  })

  // ─── C4 — dirty-hint save diff, and its interaction with the 0.1 baseline ──
  //
  // `saveSite` used to scan every node of every page on every autosave tick,
  // ignoring `opts.dirty` entirely. This filters the main prop/text/style/tag
  // loop to only the pages `opts.dirty.pageIds` names (or `opts.dirty.all`),
  // falling back to a full scan when `opts.dirty` is absent — matching
  // `SaveSiteOptions`'s own documented contract.
  //
  // CRITICAL constraint verified explicitly here (per the work order): this
  // must NOT weaken 0.1's baseline-advance fix — an undo-then-save sequence
  // must still produce a reverting POST even when dirty hints are supplied.
  describe('dirty-hint save diff (C4) — filters the scan, does not weaken 0.1', () => {
    function twoPageSiteWithText(home: string, about: string) {
      return makeSite({
        pages: [
          makePage({
            id: 'home', rootNodeId: 'root',
            nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: home } }) },
          }),
          makePage({
            id: 'about', rootNodeId: 'about-root',
            nodes: { 'about-root': makeNode({ id: 'pages/About.tsx:5:1', moduleId: 'base.text', props: { text: about } }) },
          }),
        ],
      })
    }

    function dirtyHints(pageIds: string[]) {
      return {
        all: false,
        pageIds: new Set(pageIds),
        componentIds: new Set<string>(),
        layoutIds: new Set<string>(),
        deletedPageIds: new Set<string>(),
        deletedComponentIds: new Set<string>(),
        deletedLayoutIds: new Set<string>(),
      }
    }

    it('ships only the dirty page\'s edit — a changed value on a NON-dirty page is not scanned at all', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [
            makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hi' } }) } }),
            makePage({ id: 'about', rootNodeId: 'about-root', nodes: { 'about-root': makeNode({ id: 'pages/About.tsx:5:1', moduleId: 'base.text', props: { text: 'Old' } }) } }),
          ],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
      })
      await loadThenResetCalls()

      // BOTH pages' text changed since load, but only 'home' is reported
      // dirty — simulating an edit on the About page from an EARLIER,
      // already-saved tick (baseline should already match 'New' for it in a
      // real flow; here the point is purely "does the filter respect the
      // hint", so About's baseline is deliberately left stale to prove a
      // real diff there is skipped, not just absent).
      const site = twoPageSiteWithText('Hi there', 'New')
      await fsCodemodAdapter.saveSite(site, { dirty: dirtyHints(['home']) })

      expect(calls).toHaveLength(1)
      const body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string }> }
      expect(body.edits).toHaveLength(1)
      expect(body.edits[0]!.nodeId).toBe('pages/Home.tsx:3:1')
    })

    it('falls back to a full scan when opts.dirty is absent (SaveSiteOptions\' documented contract)', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [
            makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hi' } }) } }),
            makePage({ id: 'about', rootNodeId: 'about-root', nodes: { 'about-root': makeNode({ id: 'pages/About.tsx:5:1', moduleId: 'base.text', props: { text: 'Old' } }) } }),
          ],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
      })
      await loadThenResetCalls()

      // No second argument at all — the shape `usePersistence.ts`'s
      // "bootstrap a fresh draft" branch uses.
      await fsCodemodAdapter.saveSite(twoPageSiteWithText('Hi there', 'New'))

      const body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string }> }
      expect(body.edits.map((e) => e.nodeId).sort()).toEqual(['pages/About.tsx:5:1', 'pages/Home.tsx:3:1'])
    })

    it('falls back to a full scan when dirty.all is true, even with an unrelated pageIds set', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [
            makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hi' } }) } }),
            makePage({ id: 'about', rootNodeId: 'about-root', nodes: { 'about-root': makeNode({ id: 'pages/About.tsx:5:1', moduleId: 'base.text', props: { text: 'Old' } }) } }),
          ],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
      })
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(twoPageSiteWithText('Hi there', 'New'), {
        dirty: { ...dirtyHints(['some-unrelated-page-id']), all: true },
      })

      const body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string }> }
      expect(body.edits.map((e) => e.nodeId).sort()).toEqual(['pages/About.tsx:5:1', 'pages/Home.tsx:3:1'])
    })

    it('CRITICAL — does NOT weaken 0.1: an undo-then-save sequence still fires a reverting POST when dirty hints filter to only the edited page', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [
            makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hell' } }) } }),
            makePage({ id: 'about', rootNodeId: 'about-root', nodes: { 'about-root': makeNode({ id: 'pages/About.tsx:5:1', moduleId: 'base.text', props: { text: 'Untouched' } }) } }),
          ],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
        '/admin/api/studio/save': { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false },
      })
      await loadThenResetCalls()

      // Only 'home' is dirty (the 'about' page was never touched this
      // session) — matching how a real edit on ONE page marks ONLY that
      // page via `_dirtySave`.
      const homeDirty = { dirty: dirtyHints(['home']) }

      // "Hell" -> "Hello", autosave fires with home-only dirty hints.
      await fsCodemodAdapter.saveSite(twoPageSiteWithText('Hello', 'Untouched'), homeDirty)
      expect(calls).toHaveLength(1)
      let body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: unknown; value?: unknown }> }
      expect(body.edits).toHaveLength(1)
      calls = []

      // Undo reverts 'home' back to "Hell" in memory; 'home' is STILL the
      // only dirty page (the undo itself re-marks it dirty via
      // `undoRedoActions.ts`'s own dirty-tracking in the real store, which
      // this test simulates by passing the same home-only hint again).
      await fsCodemodAdapter.saveSite(twoPageSiteWithText('Hell', 'Untouched'), homeDirty)

      // Without 0.1's baseline advance, this would see "current === baseline"
      // (both "Hell") and skip the POST — silently leaving "Hello" on disk
      // forever. C4's page-filtering must not have interfered with that: the
      // 'home' page is exactly the one the filter kept scanning both times.
      expect(calls).toHaveLength(1)
      body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: unknown; value?: unknown }> }
      expect(body.edits).toHaveLength(1)
      expect(body.edits[0]!.nodeId).toBe('pages/Home.tsx:3:1')
    })

    it('CRITICAL — a page excluded from BOTH scans (never dirty) never contributes a bump, and its baseline is left exactly as loaded', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [
            makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hi' } }) } }),
            makePage({ id: 'about', rootNodeId: 'about-root', nodes: { 'about-root': makeNode({ id: 'pages/About.tsx:5:1', moduleId: 'base.text', props: { text: 'Old' } }) } }),
          ],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
        '/admin/api/studio/save': { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false },
      })
      await loadThenResetCalls()

      // 'about' changed to 'New' in the live tree but is NEVER marked dirty
      // across either save — simulating a value that changed only because
      // of some non-mutateSite path (a bug elsewhere) so it should NOT ship,
      // and later, once 'about' genuinely becomes dirty, the diff must still
      // compare against the ORIGINAL load-time baseline ('Old'), not
      // whatever 'New' would have wrongly become.
      await fsCodemodAdapter.saveSite(twoPageSiteWithText('Hi', 'New'), { dirty: dirtyHints(['home']) })
      expect(calls).toHaveLength(0) // 'home' unchanged from baseline, 'about' filtered out — nothing to ship

      calls = []
      await fsCodemodAdapter.saveSite(twoPageSiteWithText('Hi', 'New'), { dirty: dirtyHints(['about']) })

      expect(calls).toHaveLength(1)
      const body = calls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: unknown; value?: unknown }> }
      expect(body.edits).toHaveLength(1)
      expect(body.edits[0]!.nodeId).toBe('pages/About.tsx:5:1')
      // Proves the baseline still held 'Old' for 'about' the whole time —
      // the first (filtered-out) save did NOT silently adopt 'New' as the
      // new baseline, which would have made this second diff see no change.
    })
  })

  // ─── Phase 0 seam A (item 0.7) — the unexplained-skips toast names the node ──
  describe('save-skip toast names the affected node (0.7 seam)', () => {
    function collectToasts(): Toast[] {
      let latest: Toast[] = []
      subscribeToasts((snapshot) => {
        latest = [...snapshot]
      })
      return latest
    }

    it('a skip with no matching refusal produces a toast naming the real node label, not a bare count', async () => {
      stubFetch({
        '/admin/api/studio/load': {
          dir: '/tmp/studio-test', projectName: 'studio-test',
          pages: [makePage({
            rootNodeId: 'root',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['pages/Home.tsx:3:1'] }),
              'pages/Home.tsx:3:1': makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', label: 'Headline', props: { text: 'Hi' } }),
            },
          })],
          componentSources: {}, styleRules: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [],
        },
        // written:0, skipped:1, and the server names exactly that node via
        // `unexplainedSkips` (Phase 0 item 0.7's new field) — no matching
        // `refusals` entry, so this is the "no writable location" case.
        '/admin/api/studio/save': {
          ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: false,
          unexplainedSkips: [{ nodeId: 'pages/Home.tsx:3:1', kind: 'text' }],
        },
      })
      await loadThenResetCalls()

      const site = makeSite({
        pages: [makePage({
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['pages/Home.tsx:3:1'] }),
            'pages/Home.tsx:3:1': makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', label: 'Headline', props: { text: 'Bye' } }),
          },
        })],
      })
      useEditorStore.setState({ site, activePageId: site.pages[0]!.id } as Parameters<typeof useEditorStore.setState>[0])

      await fsCodemodAdapter.saveSite(site)

      const toasts = collectToasts()
      expect(toasts).toHaveLength(1)
      // Named by the real node label ("Headline"), not the old bare-count
      // "1 edit had no writable location" message.
      expect(toasts[0].body).toContain('Headline')
      expect(toasts[0].action?.label).toBe('Select node')
    })

    it('an older/dev server response with no unexplainedSkips field produces no toast, not a crash', async () => {
      stubFetch({
        '/admin/api/studio/save': {
          ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: false,
          // No `unexplainedSkips` key at all — tolerant-rollout shape.
        },
      })
      await loadThenResetCalls()

      const site = makeSite({
        pages: [makePage({
          rootNodeId: 'root',
          nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Bye' } }) },
        })],
      })

      await fsCodemodAdapter.saveSite(site)

      expect(collectToasts()).toHaveLength(0)
    })
  })

  // ─── Track B2 — classIds drift reaches disk as a `kind: 'class'` edit ──────
  //
  // Phase 0 item 0.6 shipped an HONEST REFUSAL: a class assignment mutated
  // `node.classIds` in memory only and produced a warning toast at save time,
  // never a write. Track B2 replaces that with a real write for any node with
  // a writable source location (`setJsxClassName`/`collectClassNameEdits`) —
  // the tests below prove the write actually happens and the toast is gone
  // for that case. A node with NO writable source location at all (a `.map`
  // row, a synthetic root) still has nowhere honest to write to, so it keeps
  // Phase 0.6's toast — the second `describe` below proves that residual case
  // is unchanged.
  describe('class assignment on a writable node reaches disk (Track B2)', () => {
    function collectToasts(): Toast[] {
      let latest: Toast[] = []
      subscribeToasts((snapshot) => {
        latest = [...snapshot]
      })
      return latest
    }

    function siteWithClassIds(classIds: string[]) {
      return makeSite({
        styleRules: { 'class-1': { id: 'class-1', name: 'card', kind: 'class', styles: {}, contexts: {} } as never },
        pages: [makePage({
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['pages/Home.tsx:3:1'] }),
            'pages/Home.tsx:3:1': makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.container', label: 'Card', classIds }),
          },
        })],
      })
    }

    it('assigning a class sends exactly one `kind: \'class\'` edit and produces no toast', async () => {
      stubFetch()
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(siteWithClassIds(['class-1']))

      const saveCall = calls.find((c) => c.url === '/admin/api/studio/save')
      expect(saveCall).toBeDefined()
      const body = saveCall!.body as { edits: Array<Record<string, unknown>> }
      const classEdits = body.edits.filter((e) => e.kind === 'class')
      expect(classEdits).toEqual([{ kind: 'class', nodeId: 'pages/Home.tsx:3:1', add: ['card'], remove: [] }])
      expect(collectToasts()).toHaveLength(0)
    })

    it('removing a class sends `remove: [\'card\']`', async () => {
      stubFetch()
      await loadThenResetCalls()

      // First save assigns the class (advances the baseline), then a second
      // save with it removed again — this is the `removedClassIds` half of
      // the diff, not exercised by the add-only test above.
      await fsCodemodAdapter.saveSite(siteWithClassIds(['class-1']))
      calls = []

      await fsCodemodAdapter.saveSite(siteWithClassIds([]))

      const saveCall = calls.find((c) => c.url === '/admin/api/studio/save')
      expect(saveCall).toBeDefined()
      const body = saveCall!.body as { edits: Array<Record<string, unknown>> }
      const classEdits = body.edits.filter((e) => e.kind === 'class')
      expect(classEdits).toEqual([{ kind: 'class', nodeId: 'pages/Home.tsx:3:1', add: [], remove: ['card'] }])
    })

    it('does NOT re-send the same class edit on the next save tick when nothing further changed', async () => {
      stubFetch()
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(siteWithClassIds(['class-1']))
      calls = []

      // Autosave fires again 2s later with the SAME classIds — the baseline
      // advanced after the first save, so no `class` edit (and, since
      // nothing else changed either, no request at all) should be sent.
      await fsCodemodAdapter.saveSite(siteWithClassIds(['class-1']))
      expect(calls.find((c) => c.url === '/admin/api/studio/save')).toBeUndefined()
    })

    it('a server-side refusal (e.g. css-module-binding) surfaces as a named toast, not a silent drop', async () => {
      stubFetch({
        '/admin/api/studio/save': {
          ok: true,
          written: 0,
          skipped: 1,
          shifted: false,
          sharedComponents: false,
          refusals: [
            {
              nodeId: 'pages/Home.tsx:3:1',
              kind: 'class',
              reason: 'css-module-binding',
              message: 'className is bound to a CSS Modules import — edit the class declaration instead.',
            },
          ],
        },
      })
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(siteWithClassIds(['class-1']))

      const toasts = collectToasts()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].kind).toBe('error')
      expect(toasts[0].title).toBe('Class change not saved to source')
      expect(toasts[0].body).toContain('CSS Modules')
    })
  })

  describe('class assignment on a node with no writable source location still warns (0.6 residual)', () => {
    function collectToasts(): Toast[] {
      let latest: Toast[] = []
      subscribeToasts((snapshot) => {
        latest = [...snapshot]
      })
      return latest
    }

    // `#2` marks this as a `.map` iteration — `hasWritableSourceLocation`
    // reports `false` for it (one piece of source JSX renders every row), so
    // there is genuinely nowhere honest for `setJsxClassName` to write.
    function siteWithUnwritableClassIds(classIds: string[]) {
      return makeSite({
        styleRules: { 'class-1': { id: 'class-1', name: 'card', kind: 'class', styles: {}, contexts: {} } as never },
        pages: [makePage({
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['pages/Home.tsx:3:1#2'] }),
            'pages/Home.tsx:3:1#2': makeNode({ id: 'pages/Home.tsx:3:1#2', moduleId: 'base.container', label: 'Card', classIds }),
          },
        })],
      })
    }

    it('assigning a class produces exactly ONE warning toast naming the node and class, and sends no edit', async () => {
      stubFetch()
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(siteWithUnwritableClassIds(['class-1']))

      const toasts = collectToasts()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].kind).toBe('warning')
      expect(toasts[0].body).toContain('card')
      expect(toasts[0].body).toContain('Card')
      // No writable location — nothing was sent to save, so no request at all.
      expect(calls.find((c) => c.url === '/admin/api/studio/save')).toBeUndefined()
    })

    it('does NOT re-toast on the next save tick when nothing further changed', async () => {
      stubFetch()
      await loadThenResetCalls()

      await fsCodemodAdapter.saveSite(siteWithUnwritableClassIds(['class-1']))
      expect(collectToasts()).toHaveLength(1)
      // The toast bus only auto-resets BETWEEN tests (the global `afterEach`
      // in `src/__tests__/setup.ts`) — within this ONE test, the first save's
      // toast is still sitting in the bus, so it must be drained explicitly
      // before the second `collectToasts()` call below can tell "no NEW
      // toast" apart from "the same toast is still there."
      __resetToastBusForTests()

      // Autosave fires again 2s later with the SAME classIds — the baseline
      // advanced after the first save, so this must be silent.
      await fsCodemodAdapter.saveSite(siteWithUnwritableClassIds(['class-1']))
      expect(collectToasts()).toHaveLength(0)
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
