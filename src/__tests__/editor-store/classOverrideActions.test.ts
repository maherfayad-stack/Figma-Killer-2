/**
 * G-2b through the real store: a class edit made to an element inside a
 * component instance is an override of THAT instance, driven the whole road
 * with a stubbed network (the `instanceOverrideActions.test.ts` harness):
 *
 *   - the canvas shows the new look on the one element at once, and the shared
 *     class is not touched (no other instance moves while the write is on the
 *     wire), nor does the autosave diff write it to the element;
 *   - ONE `expose-class` edit goes out, ONE undo entry (the journal's `restore`)
 *     lands, and an info toast offers "Apply to all (N)";
 *   - "Apply to all" posts `promote-class-override` for the properties edited;
 *   - what the codemod cannot prove (an element inside the component, a value
 *     being cleared, a refusal it names) keeps the ordinary class write and says
 *     why in one sentence;
 *   - "Edit main component" steps the router aside.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
import type { Page, StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { resetLoadedValues } from '@site/studio/loadedValuesBaseline'
import { replaceStyleRuleSources } from '@site/studio/cssInsertDestination'
import { collectNodeDiffEdits } from '@site/studio/nodeDiffWriteback'
import { makeNode, makePage, makeSite } from '../fixtures'

const PAGE_ID = 'home'
const ROOT_ID = 'pages/Home.tsx:4:5'
const TIER_A = 'pages/Home.tsx:5:7'
const TIER_B = 'pages/Home.tsx:6:7'
const ROOT_A = `${TIER_A}~components/Tier.tsx:5:5`
const ROOT_B = `${TIER_B}~components/Tier.tsx:5:5`
const NAME_A = `${TIER_A}~components/Tier.tsx:6:7`
const TOKEN = 'a'.repeat(32)
const RULE_ID = 'sc-tier'

const tierRule: StyleRule = {
  id: RULE_ID,
  name: 'tier',
  kind: 'class',
  selector: '.tier',
  order: 0,
  styles: { padding: '8px' },
  contextStyles: {},
  createdAt: 1,
  updatedAt: 1,
} as StyleRule

function instance(id: string, name: string, children: string[]) {
  return makeNode({ id, moduleId: 'studio.instance', props: { componentName: 'Tier', source: 'local', sourceFile: 'components/Tier.tsx', callSiteProps: { name } }, children })
}

function inlined(id: string, extra: Parameters<typeof makeNode>[0]) {
  return { ...makeNode({ ...extra, id }), fromComponent: 'Tier' }
}

function page(): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children: [TIER_A, TIER_B] }),
      [TIER_A]: instance(TIER_A, 'Basic', [ROOT_A]),
      [TIER_B]: instance(TIER_B, 'Plus', [ROOT_B]),
      [ROOT_A]: inlined(ROOT_A, { moduleId: 'base.container', classIds: [RULE_ID], children: [NAME_A] }),
      [ROOT_B]: inlined(ROOT_B, { moduleId: 'base.container', classIds: [RULE_ID] }),
      [NAME_A]: inlined(NAME_A, { moduleId: 'base.text', props: { text: 'Basic', tag: 'h3' }, classIds: [RULE_ID] }),
    },
  })
}

interface SaveAnswer {
  undoToken?: string
  refusals?: { nodeId: string; kind: string; reason: string; message: string }[]
}

let originalFetch: typeof globalThis.fetch
let unregisterSave: (() => void) | null = null
let patchListener: ((evt: Event) => void) | null = null
let saveCalls: { edits: Record<string, unknown>[] }[] = []

function stubFetch(answers: SaveAnswer[]): void {
  let call = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0]
    if (path === '/admin/api/studio/save') {
      saveCalls.push(init?.body ? JSON.parse(String(init.body)) : { edits: [] })
      const answer = answers[Math.min(call, answers.length - 1)] ?? {}
      call += 1
      const written = answer.refusals ? 0 : 1
      return new Response(
        JSON.stringify({
          ok: true,
          written,
          skipped: answer.refusals?.length ?? 0,
          refusals: answer.refusals ?? [],
          shifted: written > 0,
          sharedComponents: true,
          touchedFiles: ['pages/Home.tsx', 'components/Tier.tsx', 'components/Tier.css'],
          createdNodeIds: [],
          relocatedNodeIds: [],
          removed: [],
          ...(answer.undoToken ? { undoToken: answer.undoToken } : {}),
        }),
        { status: 200 },
      )
    }
    if (path === '/admin/api/studio/reload-scope') {
      return new Response(JSON.stringify({ ok: true, narrow: true, pageIds: [PAGE_ID] }), { status: 200 })
    }
    if (path === '/admin/api/studio/load') {
      const pages = [page()]
      const lines = [
        {
          kind: 'meta',
          dir: '/tmp/studio-test',
          projectName: 'studio-test',
          componentSources: {},
          styleRules: { [RULE_ID]: tierRule },
          styleRuleSources: { [RULE_ID]: { file: 'components/Tier.css', selector: '.tier' } },
          styledStyleRuleSources: {},
          conditions: [],
          vendorCss: '',
          authoredCss: '',
          trust: 'static',
          paletteHiddenModuleIds: [],
          pageList: pages.map(({ id, slug, title }) => ({ id, slug, title })),
        },
        ...pages.map((p, index) => ({ kind: 'page', page: p, index })),
      ]
      return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function currentToasts(): Toast[] {
  let snapshot: Toast[] = []
  subscribeToasts((toasts) => {
    snapshot = toasts
  })()
  return snapshot
}

const store = () => useEditorStore.getState()
const paddingOf = (id: string) => (store().site!.pages[0]!.nodes[id]!.inlineStyles as { padding?: string } | undefined)?.padding

beforeEach(() => {
  __resetToastBusForTests()
  resetStructuralCommitQueue()
  originalFetch = globalThis.fetch
  saveCalls = []
  unregisterSave = registerEditorSave(async () => {})
  setStudioLoadedDir('/tmp/studio-test')
  replaceStyleRuleSources({ [RULE_ID]: { file: 'components/Tier.css', selector: '.tier' } })
  const p = page()
  resetLoadedValues([p])
  store().loadSite(makeSite({ pages: [p], styleRules: { [RULE_ID]: tierRule } }))
  store().setActivePage(PAGE_ID)
  useEditorStore.setState({ mainEditTarget: null } as Parameters<typeof useEditorStore.setState>[0])
  patchListener = (evt: Event) => {
    applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
  }
  window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  unregisterSave?.()
  if (patchListener) window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
  setStudioLoadedDir(null)
  replaceStyleRuleSources({})
  resetStructuralCommitQueue()
  store().clearSite()
})

describe('a class edit on the root of a component instance', () => {
  it('previews on this element only, posts ONE expose-class, and leaves the shared class alone', async () => {
    stubFetch([{ undoToken: TOKEN }])
    const taken = store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { paddingTop: '20px', paddingRight: '8px', paddingBottom: '8px', paddingLeft: '8px' }, contextId: null })
    expect(taken).toBe(true)
    // This instance shows it; the other and the shared rule do not.
    expect((store().site!.pages[0]!.nodes[ROOT_A]!.inlineStyles as { paddingTop?: string }).paddingTop).toBe('20px')
    expect(paddingOf(ROOT_B)).toBeUndefined()
    expect(store().site!.styleRules[RULE_ID]!.styles).toEqual({ padding: '8px' })
    // Not a history entry, and the autosave diff does not write the preview to the element.
    expect(store().canUndo).toBe(false)
    expect(collectNodeDiffEdits(store().site!.pages, undefined).edits).toEqual([])

    await waitFor(() => saveCalls.length === 1)
    expect(saveCalls[0]!.edits).toEqual([{ kind: 'expose-class', nodeId: ROOT_A, file: 'components/Tier.css', selector: '.tier', declarations: { padding: '20px 8px 8px' } }])
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Changed on this Tier only'))
    expect(store().canUndo).toBe(true)
    const toast = currentToasts().find((candidate) => candidate.title === 'Changed on this Tier only')!
    expect(toast.kind).toBe('info')
    expect(toast.action?.label).toBe('Apply to all (2)')

    store().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'restore', nodeId: `undo-journal:${TOKEN}`, token: TOKEN }])
  })

  it('"Apply to all" posts promote-class-override for the properties edited, addressed through the instance\'s root', async () => {
    stubFetch([{ undoToken: TOKEN }, { undoToken: 'b'.repeat(32) }])
    store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { gap: '12px' }, contextId: null })
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Changed on this Tier only'))
    const toast = currentToasts().find((candidate) => candidate.title === 'Changed on this Tier only')!
    await toast.action!.onSelect()
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'promote-class-override', nodeId: ROOT_A, file: 'components/Tier.css', selector: '.tier', properties: ['gap'] }])
  })

  it('a colour set over a variable binding is the instance alone, and the notice says the component keeps the variable', async () => {
    stubFetch([{ undoToken: TOKEN }])
    const bound = { ...tierRule, styles: { padding: '8px', color: 'var(--probe-accent)' } } as StyleRule
    store().loadSite(makeSite({ pages: [page()], styleRules: { [RULE_ID]: bound } }))
    store().setActivePage(PAGE_ID)
    store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { color: '#00aa00' }, contextId: null })
    await waitFor(() => saveCalls.length === 1)
    // The shared rule keeps its binding in the store as on disk; only the override edit carries the literal.
    expect(store().site!.styleRules[RULE_ID]!.styles).toMatchObject({ color: 'var(--probe-accent)' })
    expect(saveCalls[0]!.edits[0]).toMatchObject({ kind: 'expose-class', declarations: { color: '#00aa00' } })
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Changed on this Tier only'))
    const body = currentToasts().find((candidate) => candidate.title === 'Changed on this Tier only')!.body
    expect(body).toContain('color is #00aa00 here instead of var(--probe-accent); Tier keeps the variable.')
  })

  it('a value set to another variable is not reported as a replaced binding', async () => {
    stubFetch([{ undoToken: TOKEN }])
    const bound = { ...tierRule, styles: { color: 'var(--probe-accent)' } } as StyleRule
    store().loadSite(makeSite({ pages: [page()], styleRules: { [RULE_ID]: bound } }))
    store().setActivePage(PAGE_ID)
    store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { color: 'var(--brand)' }, contextId: null })
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Changed on this Tier only'))
    expect(currentToasts().find((candidate) => candidate.title === 'Changed on this Tier only')!.body).not.toContain('keeps the variable')
  })

  it('a refusal the codemod names takes the preview back, applies the ordinary class write, and says why in one sentence', async () => {
    stubFetch([{ refusals: [{ nodeId: ROOT_A, kind: 'expose-class', reason: 'class-filtered', message: 'x' }] }])
    store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { gap: '12px' }, contextId: null })
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Not limited to this instance'))
    const toast = currentToasts().find((candidate) => candidate.title === 'Not limited to this instance')!
    expect(toast.body).toBe("A component around Tier doesn't pass the class on, so this changes every Tier.")
    expect(store().site!.styleRules[RULE_ID]!.styles).toMatchObject({ gap: '12px' })
    expect(store().canUndo).toBe(true)
  })
})

describe('what an instance cannot give its own class keeps the ordinary write, with the reason', () => {
  it('an element inside the component is the shared class: nothing is posted and the notice says so', () => {
    stubFetch([{}])
    const taken = store().overrideClassOnInstance({ nodeId: NAME_A, classId: RULE_ID, patch: { gap: '12px' }, contextId: null })
    expect(taken).toBe(false)
    expect(saveCalls).toHaveLength(0)
    const toast = currentToasts().find((candidate) => candidate.title === 'Not limited to this instance')
    expect(toast?.body).toBe("This element is styled by a class Tier shares, and only Tier's outermost element can take a class for one instance, so this changes every Tier.")
  })

  it('clearing a value cannot be limited to one instance', () => {
    stubFetch([{}])
    expect(store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { padding: null }, contextId: null })).toBe(false)
    expect(currentToasts().find((candidate) => candidate.title === 'Not limited to this instance')?.body).toContain("removing a value can't be limited to one instance")
  })

  it('"Edit main component" steps aside, and a node outside a component is never its business', () => {
    stubFetch([{}])
    store().setMainEditTarget({ kind: 'component', name: 'Tier' })
    expect(store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { gap: '12px' }, contextId: null })).toBe(false)
    expect(store().overrideClassOnInstance({ nodeId: ROOT_ID, classId: RULE_ID, patch: { gap: '12px' }, contextId: null })).toBe(false)
    expect(saveCalls).toHaveLength(0)
    expect(currentToasts()).toHaveLength(0)
  })

  it('a class with no stylesheet source (compiled or generated) stays the ordinary write', () => {
    stubFetch([{}])
    replaceStyleRuleSources({})
    expect(store().overrideClassOnInstance({ nodeId: ROOT_A, classId: RULE_ID, patch: { gap: '12px' }, contextId: null })).toBe(false)
    expect(saveCalls).toHaveLength(0)
  })
})
