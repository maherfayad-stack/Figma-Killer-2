/**
 * studioSaveRequests — `commitStructural` (0.2 / audit E2's fix, and Track C5
 * "reload surgery" on top of it).
 *
 * Covers the behavioral changes the two fixes make to every structural commit
 * (`commitStudioMove` / `commitStudioDelete` / `commitStudioInsert`, which all
 * share `commitStructural`):
 *
 *   1. A pending debounced editor save is flushed and AWAITED before the
 *      structural edit is even posted — so a prop/text/style edit still
 *      inside its 2s autosave window lands (and its own save-diff baseline
 *      advances, per 0.1) before this write can shift the ids it targets or
 *      a later reload can discard it.
 *   2. A "reload" fires ONLY when the response reports `written > 0` — never
 *      unconditionally from a `finally` block. Nothing reaching disk means
 *      there's nothing to resync from; reloading anyway would replace the
 *      canvas's optimistic state with the unchanged, pre-edit source.
 *   3. Track C5 — when a reload IS warranted, `reloadStructuralScope` tries a
 *      TARGETED per-page resync first (`POST /reload-scope` then `?pageIds=`)
 *      and only falls back to the full `CMS_SITE_RELOAD_EVENT` reload when
 *      the server says the touched files are not narrow-safe, or when any
 *      step of the narrow path fails for any reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { commitStudioDelete, commitStudioInsert, commitStudioMove, setStudioLoadedDir } from '../studioSaveRequests'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { CMS_SITE_PAGES_PATCH_EVENT, CMS_SITE_RELOAD_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

describe('commitStructural (via commitStudioMove / commitStudioDelete / commitStudioInsert)', () => {
  let originalFetch: typeof globalThis.fetch
  let order: string[]
  let calls: Array<{ url: string; body: unknown }>
  let unregisterSave: (() => void) | null

  beforeEach(() => {
    __resetToastBusForTests()
    originalFetch = globalThis.fetch
    order = []
    calls = []
    unregisterSave = null
    setStudioLoadedDir('/tmp/studio-test')
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
  })

  /**
   * Routes by path, matching `fsCodemodAdapter.test.ts`'s `stubFetch`
   * pattern. `saveBody` answers `POST /save`; `reloadScopeBody` (default:
   * "not safe", the honest fallback) answers `POST /reload-scope`;
   * `loadPagesFor` answers `GET /load?pageIds=…&stream=1` — the SAME NDJSON
   * shape `fetchStudioPagesById` reads in production, keyed by the
   * comma-joined `pageIds` query value the request actually carried, so a
   * test can hand back different content per page id.
   */
  function stubFetch(opts: {
    saveBody: unknown
    reloadScopeBody?: unknown
    loadPagesFor?: Record<string, unknown[]>
  }) {
    const reloadScopeBody = opts.reloadScopeBody ?? { ok: true, narrow: false }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })
      if (url.includes('/admin/api/studio/reload-scope')) {
        order.push('reload-scope')
        return new Response(JSON.stringify(reloadScopeBody), { status: 200 })
      }
      if (url.includes('/admin/api/studio/load')) {
        order.push('load')
        const query = new URL(url, 'http://localhost').searchParams
        const key = query.get('pageIds') ?? ''
        const pages = opts.loadPagesFor?.[key] ?? []
        const lines = [
          { kind: 'meta', dir: '/tmp/studio-test', projectName: 'studio-test', componentSources: {}, styleRules: {}, styleRuleSources: {}, conditions: [], vendorCss: '', trust: 'static', paletteHiddenModuleIds: [], pageCount: pages.length },
          ...pages.map((page) => ({ kind: 'page', page })),
        ]
        return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 })
      }
      order.push('post')
      return new Response(JSON.stringify(opts.saveBody), { status: 200 })
    }) as typeof fetch
  }

  function registerFlush(impl: () => Promise<void> = async () => { order.push('flush') }) {
    unregisterSave = registerEditorSave(async () => {
      await impl()
    })
  }

  async function countEvents(eventName: string, run: () => Promise<void>): Promise<number> {
    let count = 0
    const onEvent = () => { count += 1 }
    window.addEventListener(eventName, onEvent)
    try {
      await run()
    } finally {
      window.removeEventListener(eventName, onEvent)
    }
    return count
  }

  it('flushes the pending editor save and AWAITS it before posting the structural edit', async () => {
    registerFlush()
    stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] } })

    await commitStudioMove('node-a', 'node-b', 'after')

    // 'post' (the /save call), then 'reload-scope' (the C5 narrow-reload
    // check, gated on `written > 0`) — the flush is always first.
    expect(order).toEqual(['flush', 'post', 'reload-scope'])
  })

  it('a flush failure is logged but does not block the structural edit from posting', async () => {
    registerFlush(async () => {
      order.push('flush-failed')
      throw new Error('boom')
    })
    stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] } })

    await commitStudioMove('node-a', 'node-b', 'after')

    expect(order).toEqual(['flush-failed', 'post', 'reload-scope'])
  })

  it('proceeds normally with no editor mounted (flushEditorSave is a no-op)', async () => {
    // No registerFlush() call — simulates the MCP/headless case where
    // `usePersistence` never mounted.
    stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] } })

    const reloads = await countEvents(CMS_SITE_RELOAD_EVENT, () => commitStudioMove('node-a', 'node-b', 'after'))

    // reload-scope's default stub answer is "not safe" (`narrow: false`), so
    // this still falls back to exactly one full reload.
    expect(reloads).toBe(1)
  })

  describe('reload is gated on a write actually landing (trap #5)', () => {
    it('does NOT check reload-scope or reload when the batch was entirely refused (written: 0)', async () => {
      stubFetch({
        saveBody: {
          ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: false, touchedFiles: [],
          refusals: [{ nodeId: 'node-a', kind: 'move', reason: 'residual-formatting', message: 'Could not move byte-exactly.' }],
        },
      })

      const reloads = await countEvents(CMS_SITE_RELOAD_EVENT, () => commitStudioMove('node-a', 'node-b', 'after'))

      expect(reloads).toBe(0)
      expect(order).toEqual(['post']) // no reload-scope call at all
    })

    it('does NOT reload when the batch was entirely skipped with no refusal (stale id)', async () => {
      stubFetch({ saveBody: { ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: false, touchedFiles: [] } })

      const reloads = await countEvents(CMS_SITE_RELOAD_EVENT, () => commitStudioDelete(['node-a']))

      expect(reloads).toBe(0)
    })

    it('DOES reload (falling back, since reload-scope defaults to not-safe) when a write landed', async () => {
      stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] } })

      const reloads = await countEvents(CMS_SITE_RELOAD_EVENT, () => commitStudioMove('node-a', 'node-b', 'after'))

      expect(reloads).toBe(1)
    })

    it('does NOT reload when the request itself throws (no response to check `written` against)', async () => {
      globalThis.fetch = (async () => {
        throw new Error('network down')
      }) as typeof fetch

      const reloads = await countEvents(CMS_SITE_RELOAD_EVENT, () => commitStudioMove('node-a', 'node-b', 'after'))

      expect(reloads).toBe(0)
    })
  })

  // ---------------------------------------------------------------------
  // Track C5 — targeted reload
  // ---------------------------------------------------------------------
  describe('reloadStructuralScope (Track C5)', () => {
    it('posts the /save response\'s touchedFiles to /reload-scope', async () => {
      stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: true, touchedFiles: ['pages/Home.tsx'] } })

      await commitStudioMove('node-a', 'node-b', 'after')

      const scopeCall = calls.find((c) => c.url.includes('/reload-scope'))
      expect(scopeCall).toBeDefined()
      expect((scopeCall!.body as { files: string[] }).files).toEqual(['pages/Home.tsx'])
    })

    it('narrow: true — patches ONLY the named pages via CMS_SITE_PAGES_PATCH_EVENT, and does NOT fire a full reload', async () => {
      const freshHome = makePage({
        id: 'home', slug: 'index', title: 'Home', rootNodeId: 'root',
        nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) },
      })
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] },
        reloadScopeBody: { ok: true, narrow: true, pageIds: ['home'] },
        loadPagesFor: { home: [freshHome] },
      })

      let patchDetail: CmsSitePagesPatchDetail | null = null
      const onPatch = (evt: Event) => { patchDetail = (evt as CustomEvent<CmsSitePagesPatchDetail>).detail }
      window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, onPatch)
      const fullReloads = await countEvents(CMS_SITE_RELOAD_EVENT, () =>
        commitStudioMove('node-a', 'node-b', 'after'),
      )
      window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, onPatch)

      expect(fullReloads).toBe(0)
      expect(patchDetail).not.toBeNull()
      expect(patchDetail!.pages.map((p) => p.id)).toEqual(['home'])
      expect(patchDetail!.removedPageIds).toEqual([])
      // The load call asked for exactly the named page, not the whole project.
      const loadCall = calls.find((c) => c.url.includes('/admin/api/studio/load'))
      expect(loadCall!.url).toContain('pageIds=home')
    })

    it('narrow: false — falls back to the existing full reload, with no page-patch event', async () => {
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['components/Card.tsx'] },
        reloadScopeBody: { ok: true, narrow: false },
      })

      let patched = false
      const onPatch = () => { patched = true }
      window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, onPatch)
      const fullReloads = await countEvents(CMS_SITE_RELOAD_EVENT, () =>
        commitStudioDelete(['node-a']),
      )
      window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, onPatch)

      expect(fullReloads).toBe(1)
      expect(patched).toBe(false)
      // Never asked /load for anything narrow.
      expect(calls.some((c) => c.url.includes('/admin/api/studio/load'))).toBe(false)
    })

    it('a thrown /reload-scope request still resolves to a full reload, never leaves the board unreconciled', async () => {
      stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] } })
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/admin/api/studio/reload-scope')) throw new Error('network down')
        return realFetch(input, init)
      }) as typeof fetch

      const fullReloads = await countEvents(CMS_SITE_RELOAD_EVENT, () =>
        commitStudioInsert({
          parentNodeId: 'node-a',
          anchorNodeId: null,
          position: 'after',
          name: 'Button',
          importSpecifier: '@alm-design/design-system',
          props: {},
        }),
      )

      expect(fullReloads).toBe(1)
    })

    it('an empty touchedFiles list (defensive — should not occur when written > 0) never calls /reload-scope and falls back to a full reload', async () => {
      stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: [] } })

      const fullReloads = await countEvents(CMS_SITE_RELOAD_EVENT, () => commitStudioMove('node-a', 'node-b', 'after'))

      expect(fullReloads).toBe(1)
      expect(calls.some((c) => c.url.includes('/reload-scope'))).toBe(false)
    })
  })
})
