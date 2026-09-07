/**
 * The user's own save now takes the SAME narrow reload path the agent's
 * writes already used — `fsCodemodAdapter.saveSite` -> `resyncBoardAfterWrite`
 * -> `POST /reload-scope` -> `GET /load?pageIds=` -> `patchPages`, instead of
 * the full `loadSite()` reparse of every page in the project.
 *
 * `saveSite` reported `shifted || sharedComponents` and called
 * `requestCmsSiteReload()`. On a Next.js App Router board the layout chrome is
 * shared by construction, so `sharedComponents` is true for a large share of
 * ordinary edits and the user paid a whole-board reparse ~2s after they
 * stopped typing.
 *
 * Two classes of test here, and the second is the one that matters:
 *
 *   1. **Routing** — the narrow path is taken when the scope check says it is
 *      safe, and the full reload still fires when it does not.
 *   2. **The save/reload interleaving.** A resync re-reads the touched pages
 *      from disk and rewrites the very diff baselines `saveSite` advances
 *      after its POST. Get the order wrong and the save's own commit
 *      overwrites the fresh disk baseline with the PRE-reload document —
 *      after which every prop of every reloaded page re-diffs as "the user
 *      just typed this" on the next autosave tick. And a rule the server
 *      REFUSED must keep its previous baseline THROUGH the reload, or the
 *      user's obvious retry (the same value again) diffs as "no change" and
 *      is never attempted a second time — `style-02`'s bug #3, trivially
 *      reachable again through this new path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { fsCodemodAdapter } from '../fsCodemodAdapter'
import { setStudioLoadedDir } from '../studioWorkspaceDir'
import {
  STUDIO_BREAKPOINT_ID,
  collectStyleRuleEdits,
  setStudioStyleRuleSources,
} from '../styleRuleWriteback'
import { CMS_SITE_PAGES_PATCH_EVENT, CMS_SITE_RELOAD_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'

const RULE_ID = 'sc-hero'
const CSS_FILE = 'pages/Home.css'
const SOURCES = { [RULE_ID]: { file: CSS_FILE, selector: '.hero-title' } }

function rule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: RULE_ID,
    kind: 'class',
    name: 'hero-title',
    selector: '.hero-title',
    styles: { width: '120px' },
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

/** The document as the user left it: `width` scrubbed to 321px in the studio frame's context. */
function editedRules(): Record<string, StyleRule> {
  return { [RULE_ID]: rule({ contextStyles: { [STUDIO_BREAKPOINT_ID]: { width: '321px' } } }) }
}

function siteWithEditedClass() {
  return makeSite({
    styleRules: editedRules(),
    pages: [
      makePage({
        id: 'home',
        rootNodeId: 'root',
        nodes: { root: makeNode({ id: 'pages/Home.tsx:3:1', moduleId: 'base.text', props: { text: 'Hello' } }) },
      }),
    ],
  })
}

describe('saveSite → narrow board resync', () => {
  let originalFetch: typeof globalThis.fetch
  let order: string[]
  let calls: Array<{ url: string; method: string; body: unknown }>

  beforeEach(() => {
    __resetToastBusForTests()
    originalFetch = globalThis.fetch
    order = []
    calls = []
    setStudioLoadedDir('/tmp/studio-test')
    // The as-loaded baseline: width 120px on disk.
    setStudioStyleRuleSources(SOURCES, { [RULE_ID]: rule() })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    setStudioLoadedDir(null)
  })

  /**
   * Routes by path. `/load` answers the NDJSON stream shape
   * `fetchStudioPagesById` reads, carrying `reloadedRules` as the reload's
   * project-wide registry — the half of the meta line `canvas-14` proved must
   * never be dropped.
   */
  function stubFetch(opts: {
    saveBody: Record<string, unknown>
    reloadScopeBody?: unknown
    reloadedPages?: unknown[]
    reloadedRules?: Record<string, StyleRule>
  }) {
    const reloadScopeBody = opts.reloadScopeBody ?? { ok: true, narrow: false }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const path = url.split('?')[0]

      if (path === '/admin/api/studio/reload-scope') {
        order.push('reload-scope')
        return new Response(JSON.stringify(reloadScopeBody), { status: 200 })
      }
      if (path === '/admin/api/studio/save') {
        order.push('save')
        return new Response(JSON.stringify(opts.saveBody), { status: 200 })
      }
      if (path === '/admin/api/studio/framework') {
        order.push('framework')
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        return new Response(JSON.stringify({ ok: true, framework: body.framework ?? null, fonts: body.fonts ?? null }), { status: 200 })
      }
      if (path === '/admin/api/studio/load') {
        order.push('load')
        const pages = opts.reloadedPages ?? []
        const lines = [
          {
            kind: 'meta',
            dir: '/tmp/studio-test',
            projectName: 'studio-test',
            componentSources: {},
            styleRules: opts.reloadedRules ?? {},
            styleRuleSources: SOURCES,
            styledStyleRuleSources: {},
            conditions: [],
            vendorCss: '',
            authoredCss: '',
            trust: 'static',
            paletteHiddenModuleIds: [],
            pageCount: pages.length,
          },
          ...pages.map((page) => ({ kind: 'page', page })),
        ]
        return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as typeof fetch
  }

  async function record(run: () => Promise<void>): Promise<{ reloads: number; patches: CmsSitePagesPatchDetail[] }> {
    let reloads = 0
    const patches: CmsSitePagesPatchDetail[] = []
    const onReload = () => { reloads += 1 }
    const onPatch = (evt: Event) => { patches.push((evt as CustomEvent<CmsSitePagesPatchDetail>).detail) }
    window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
    window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, onPatch)
    try {
      await run()
    } finally {
      window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
      window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, onPatch)
    }
    return { reloads, patches }
  }

  // -------------------------------------------------------------------
  // 1. Routing
  // -------------------------------------------------------------------
  describe('routing', () => {
    it('a sharedComponents save patches only the named pages — no full reload', async () => {
      const freshHome = makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: true, touchedFiles: ['components/Card.tsx'] },
        reloadScopeBody: { ok: true, narrow: true, pageIds: ['home'] },
        reloadedPages: [freshHome],
      })

      const { reloads, patches } = await record(() => fsCodemodAdapter.saveSite(siteWithEditedClass()))

      expect(reloads).toBe(0)
      expect(patches).toHaveLength(1)
      expect(patches[0]!.pages.map((page) => page.id)).toEqual(['home'])
      // Asked for exactly that page, not the whole project.
      expect(calls.find((call) => call.url.includes('/admin/api/studio/load'))!.url).toContain('pageIds=home')
      // And it forwarded the save's own touchedFiles as the scope question.
      const scope = calls.find((call) => call.url.includes('/reload-scope'))!
      expect((scope.body as { files: string[] }).files).toEqual(['components/Card.tsx'])
      expect(order).toEqual(['save', 'reload-scope', 'load'])
    })

    it('a shifted save takes the same narrow path', async () => {
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] },
        reloadScopeBody: { ok: true, narrow: true, pageIds: ['home'] },
        reloadedPages: [makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })],
      })

      const { reloads, patches } = await record(() => fsCodemodAdapter.saveSite(siteWithEditedClass()))

      expect(reloads).toBe(0)
      expect(patches).toHaveLength(1)
    })

    it('falls back to the FULL reload when the scope check cannot prove the write narrow', async () => {
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['components/Deep.tsx'] },
        reloadScopeBody: { ok: true, narrow: false },
      })

      const { reloads, patches } = await record(() => fsCodemodAdapter.saveSite(siteWithEditedClass()))

      expect(reloads).toBe(1)
      expect(patches).toHaveLength(0)
      expect(calls.some((call) => call.url.includes('/admin/api/studio/load'))).toBe(false)
    })

    it('does not resync at all when nothing shifted and nothing was shared', async () => {
      stubFetch({ saveBody: { ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] } })

      const { reloads, patches } = await record(() => fsCodemodAdapter.saveSite(siteWithEditedClass()))

      expect(reloads).toBe(0)
      expect(patches).toHaveLength(0)
      expect(order).not.toContain('reload-scope')
    })

    it('does not resync when nothing reached disk, even with shifted set', async () => {
      // `written: 0` means the document still matches the files; reloading
      // would replace the user's in-memory edit with the unchanged source.
      stubFetch({ saveBody: { ok: true, written: 0, skipped: 1, shifted: true, sharedComponents: true, touchedFiles: [] } })

      const { reloads, patches } = await record(() => fsCodemodAdapter.saveSite(siteWithEditedClass()))

      expect(reloads).toBe(0)
      expect(patches).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------
  // 2. The save/reload interleaving
  // -------------------------------------------------------------------
  describe('the save/reload interleaving', () => {
    it('the resync runs LAST — after every baseline commit', async () => {
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] },
        reloadScopeBody: { ok: true, narrow: true, pageIds: ['home'] },
        reloadedPages: [makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })],
        reloadedRules: { [RULE_ID]: rule() },
      })

      await fsCodemodAdapter.saveSite(siteWithEditedClass())

      // The POST opens the save and the resync closes it — everything
      // `saveSite` does in between (baseline commits, the framework sync)
      // has already run by the time the board is re-read from disk.
      expect(order[0]).toBe('save')
      expect(order.slice(-2)).toEqual(['reload-scope', 'load'])
    })

    it('the RELOADED registry is the surviving baseline — the pre-reload document does not overwrite it', async () => {
      // The regression an inline resync would cause: `saveSite`'s own
      // `commitStyleRuleBaseline(site.styleRules, …)` runs after the POST, so
      // resyncing before it leaves the baseline holding the PRE-reload
      // document (321px) instead of what the reload just read from disk
      // (999px) — and the next autosave tick re-sends a value the user never
      // typed.
      stubFetch({
        saveBody: { ok: true, written: 1, skipped: 0, shifted: true, sharedComponents: false, touchedFiles: ['pages/Home.tsx'] },
        reloadScopeBody: { ok: true, narrow: true, pageIds: ['home'] },
        reloadedPages: [makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })],
        reloadedRules: { [RULE_ID]: rule({ styles: { width: '999px' } }) },
      })

      await fsCodemodAdapter.saveSite(siteWithEditedClass())

      // Diffing the RELOADED registry (what `patchPages` just put in the
      // document) against the baseline must produce nothing to write.
      const plan = collectStyleRuleEdits({ [RULE_ID]: rule({ styles: { width: '999px' } }) })
      expect(plan.edits).toHaveLength(0)
    })

    it('a REFUSED rule keeps its previous baseline through the resync, so the retry is still attempted', async () => {
      // `style-02` bug #3, through the reload path. The server refused the
      // write, so 321px never reached disk — but the reload's own registry
      // reports 321px anyway (the CSSOM's last-wins read of a file whose
      // duplicate declaration is exactly WHY the write was refused). Adopting
      // that as the baseline makes the user's identical retry diff as "no
      // change": reported once, then permanently invisible.
      const plannedNodeId = collectStyleRuleEdits(editedRules()).edits[0]!.nodeId
      setStudioStyleRuleSources(SOURCES, { [RULE_ID]: rule() }) // re-arm the baseline the probe just read

      stubFetch({
        saveBody: {
          ok: true,
          written: 1,
          skipped: 1,
          shifted: true,
          sharedComponents: false,
          touchedFiles: ['pages/Home.tsx'],
          refusals: [{ nodeId: plannedNodeId, kind: 'css', reason: 'duplicate-declaration', message: 'Two declarations set width.' }],
        },
        reloadScopeBody: { ok: true, narrow: true, pageIds: ['home'] },
        reloadedPages: [makePage({ id: 'home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body' }) } })],
        reloadedRules: { [RULE_ID]: rule({ styles: { width: '321px' } }) },
      })

      await fsCodemodAdapter.saveSite(siteWithEditedClass())

      // The user's value is still pending: diffing it again must still emit.
      const retry = collectStyleRuleEdits(editedRules())
      expect(retry.edits).toHaveLength(1)
      expect(retry.edits[0]!.nodeId).toBe(plannedNodeId)
    })
  })
})
