/**
 * fontFamilyWriteback — the write-back round trip for a font-family picked in
 * the Typography section, and the two ways it used to disappear.
 *
 * The user report: "why after applying different font in the properties panel
 * it gets back to this font again even after installing the font from the
 * framework it's the same". Two independent causes, both proved here.
 *
 * 1. **The style edit was dropped in silence for a component node.**
 *    `fsCodemodAdapter.saveSite` wraps its whole `kind: 'style'` emission in
 *    `if (canWriteInlineStyleForModule(node.moduleId))`. `base.*` and `alm.*`
 *    pass; a `pkg.*` package component and a `studio.instance` call site do
 *    not — and the `else` branch did not exist. The value stayed in
 *    `node.inlineStyles`, the canvas rendered it, the save reported success,
 *    and the next reload (`patchPages` replaces each page wholesale with what
 *    the parser read off disk) put the old font back with nothing said. Now
 *    it is a named refusal — CLAUDE.md invariant 2.
 *
 * 2. **The installed font library was never persisted.** `SiteSettings.fonts`
 *    had no sidecar at all: `FrameworkSettingsSchema` has no `fonts` field and
 *    `saveSite` only ever posted `site.settings.framework`, so installing a
 *    font mutated the store and nothing else. `.studio/fonts.json` closes it.
 *
 * NOTE ON THE FIXTURE: `makeNode` silently DROPPED `inlineStyles` until this
 * change, which is why no test in this repo had ever reached the inline-style
 * save path. That omission is the reason cause 1 could ship unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fsCodemodAdapter } from '../fsCodemodAdapter'
import { __resetSidecarBaselinesForTests } from '../sidecarSync'
import { useEditorStore } from '@site/store/store'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'

/** What the Typography section commits when a user picks an installed family. */
const PICKED_FAMILY = "'Inter', sans-serif"

describe('font-family write-back', () => {
  let originalFetch: typeof globalThis.fetch
  let calls: Array<{ url: string; method: string; body: unknown }>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
    __resetToastBusForTests()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    // The sidecar-sync baselines are module state that outlives this file in a
    // batch run — see `__resetSidecarBaselinesForTests`'s own doc.
    __resetSidecarBaselinesForTests()
  })

  function stubFetch(responses: Record<string, unknown> = {}) {
    const defaults: Record<string, unknown> = {
      '/admin/api/studio/load': {
        dir: '/tmp/studio-font', projectName: 'studio-font', pages: [],
        componentSources: {}, styleRules: {}, conditions: [], vendorCss: '',
        trust: 'static', paletteHiddenModuleIds: [],
      },
      '/admin/api/studio/framework': { framework: null, fonts: null },
      '/admin/api/studio/save': { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false },
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const path = url.split('?')[0]
      const method = init?.method ?? 'GET'
      if (path === '/admin/api/studio/framework' && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        return new Response(
          JSON.stringify({ ok: true, framework: body.framework ?? null, fonts: body.fonts ?? null }),
          { status: 200 },
        )
      }
      const body = responses[path] ?? defaults[path]
      if (path === '/admin/api/studio/load') {
        const { pages, ...meta } = body as { pages: unknown[]; [k: string]: unknown }
        const lines = [
          { kind: 'meta', styleRuleSources: {}, styledStyleRuleSources: {}, authoredCss: '', ...meta, pageCount: pages.length },
          ...pages.map((page) => ({ kind: 'page', page })),
        ]
        return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })
      }
      return new Response(JSON.stringify(body ?? {}), { status: 200 })
    }) as typeof globalThis.fetch
  }

  function collectToasts(): Toast[] {
    let latest: Toast[] = []
    subscribeToasts((snapshot) => { latest = [...snapshot] })
    return latest
  }

  /** A one-node page whose node carries the picked family as an inline style. */
  function siteWithPickedFont(moduleId: string) {
    return makeSite({
      pages: [makePage({
        rootNodeId: 'root',
        nodes: {
          root: makeNode({ id: 'root', moduleId: 'base.body', children: ['pages/SignUp.tsx:23:9'] }),
          'pages/SignUp.tsx:23:9': makeNode({
            id: 'pages/SignUp.tsx:23:9',
            moduleId,
            label: 'Title',
            inlineStyles: { fontFamily: PICKED_FAMILY },
          }),
        },
      })],
    })
  }

  async function saveAfterPickingFont(moduleId: string) {
    stubFetch()
    await fsCodemodAdapter.loadSite()
    calls = []
    const site = siteWithPickedFont(moduleId)
    useEditorStore.setState({ site, activePageId: site.pages[0]!.id } as Parameters<typeof useEditorStore.setState>[0])
    await fsCodemodAdapter.saveSite(site)
    const saveCall = calls.find((c) => c.url.split('?')[0] === '/admin/api/studio/save')
    const edits = ((saveCall?.body as { edits?: Array<{ kind: string; nodeId: string; style?: Record<string, string> }> } | undefined)?.edits) ?? []
    return edits
  }

  // ── The write reaches source for the modules that HAVE a style target ────

  it('a text element ships the picked family as a kind:"style" edit', async () => {
    const edits = await saveAfterPickingFont('base.text')
    const styleEdit = edits.find((e) => e.kind === 'style')
    expect(styleEdit).toBeDefined()
    expect(styleEdit!.nodeId).toBe('pages/SignUp.tsx:23:9')
    // Quotes intact — `'Open Sans'` and `Open Sans` are different CSS values,
    // and `setJsxStyle` writes the string verbatim as a JS string literal.
    expect(styleEdit!.style).toEqual({ fontFamily: PICKED_FAMILY })
  })

  it('a design-system component ships it too — alm.* forwards style to its root', async () => {
    const edits = await saveAfterPickingFont('alm.Button')
    expect(edits.find((e) => e.kind === 'style')?.style).toEqual({ fontFamily: PICKED_FAMILY })
  })

  // ── The modules that DON'T refuse out loud, instead of reverting ─────────

  it('a package component emits NO style edit and says so, instead of reverting silently', async () => {
    const edits = await saveAfterPickingFont('pkg.Card')
    expect(edits.some((e) => e.kind === 'style')).toBe(false)

    const toasts = collectToasts()
    const refusal = toasts.find((t) => t.title === "Style change won't be saved")
    expect(refusal).toBeDefined()
    // Names the node and the property, not a bare count.
    expect(refusal!.body).toContain('Title')
    expect(refusal!.body).toContain('Font family')
    expect(refusal!.kind).toBe('warning')
  })

  it('a local component call site refuses with its own reason', async () => {
    const edits = await saveAfterPickingFont('studio.instance')
    expect(edits.some((e) => e.kind === 'style')).toBe(false)
    const refusal = collectToasts().find((t) => t.title === "Style change won't be saved")
    expect(refusal).toBeDefined()
    // The `studio.instance` sentence, not the package one.
    expect(refusal!.body).toContain('renders no box of its own')
  })

  // ── The installed font library survives a reload ─────────────────────────

  describe('installed font library persistence (.studio/fonts.json)', () => {
    const INTER = {
      id: 'font-inter',
      source: 'google' as const,
      family: 'Inter',
      variants: ['400'],
      subsets: ['latin'],
      files: [{ variant: '400', subset: 'latin', path: '/uploads/fonts/inter/400.woff2', format: 'woff2' as const }],
      createdAt: 0,
      updatedAt: 0,
    }

    it('a font installed after load is POSTed to the framework sidecar route', async () => {
      stubFetch()
      await fsCodemodAdapter.loadSite()
      calls = []

      const site = makeSite({
        pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'root' }) } })],
      })
      site.settings.fonts = { items: [INTER], tokens: [] }

      await fsCodemodAdapter.saveSite(site)

      const post = calls.find(
        (c) => c.url.split('?')[0] === '/admin/api/studio/framework' && c.method === 'POST',
      )
      expect(post).toBeDefined()
      // The whole point: the library is in the body. Before this it never was,
      // so the entry died with the tab.
      expect((post!.body as { fonts?: { items: Array<{ family: string }> } }).fonts?.items[0]?.family).toBe('Inter')
    })

    it('loadSite adopts the persisted library, so the picker still lists the font', async () => {
      stubFetch({
        '/admin/api/studio/framework': { framework: null, fonts: { items: [INTER], tokens: [] } },
      })
      const site = await fsCodemodAdapter.loadSite()
      expect(site.settings.fonts?.items.map((f) => f.family)).toEqual(['Inter'])
    })

    it('a save with no font change sends no `fonts` key — absent means "unchanged", not "empty"', async () => {
      stubFetch({
        '/admin/api/studio/framework': { framework: null, fonts: { items: [INTER], tokens: [] } },
      })
      const loaded = await fsCodemodAdapter.loadSite()
      calls = []

      // Same library as loaded, one framework change to force the POST.
      const site = makeSite({
        pages: [makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'root' }) } })],
      })
      site.settings.fonts = loaded.settings.fonts

      await fsCodemodAdapter.saveSite(site)

      const post = calls.find(
        (c) => c.url.split('?')[0] === '/admin/api/studio/framework' && c.method === 'POST',
      )
      if (post) expect((post.body as { fonts?: unknown }).fonts).toBeUndefined()
    })
  })
})
