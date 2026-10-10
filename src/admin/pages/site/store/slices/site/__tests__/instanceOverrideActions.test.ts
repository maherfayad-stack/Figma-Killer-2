/**
 * OD-19 through the real store: `updateNodeProps` / `setNodeInlineStyles` on a
 * node inside a component instance are an override of THAT instance, driven the
 * whole road with a stubbed network (the `instanceActions.test.ts` harness): a
 * real store action, a real `/save`, a narrow `/reload-scope`, a `/load`, a real
 * `undo()`.
 *
 *   - the canvas shows the new value at once and the autosave diff leaves it
 *     alone (the hold), so nothing reaches the component behind the override;
 *   - ONE `expose-prop` edit goes out, ONE undo entry (the journal's `restore`)
 *     lands, and an info toast offers "Apply to all (N)";
 *   - "Apply to all" posts `promote-override` addressed through an element of
 *     the instance, with the prop names the call site gained;
 *   - a refusal the codemod can name takes the preview back, applies the edit
 *     the ordinary way, and says in one sentence that every instance changed;
 *   - "Edit main component" steps the router aside; a node outside a component
 *     is never its business.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { resetLoadedValues } from '@site/studio/loadedValuesBaseline'
import { collectNodeDiffEdits } from '@site/studio/nodeDiffWriteback'
import { makeNode, makePage, makeSite } from '../../../../../../../__tests__/fixtures'

const PAGE_ID = 'home'
const ROOT_ID = 'pages/Home.tsx:4:5'
const CARD_A = 'pages/Home.tsx:5:7'
const CARD_B = 'pages/Home.tsx:6:7'
const HEAD_A = `${CARD_A}~components/Card.tsx:3:5`
const HEAD_B = `${CARD_B}~components/Card.tsx:3:5`
const TOKEN = 'a'.repeat(32)

function instance(id: string, title: string, extra: Record<string, unknown> = {}, children: string[] = []) {
  return makeNode({ id, moduleId: 'studio.instance', props: { componentName: 'Card', source: 'local', sourceFile: 'components/Card.tsx', callSiteProps: { title, ...extra } }, children })
}

function heading(id: string, props: Record<string, unknown> = { text: 'Current', tag: 'h2' }, extra: Partial<Parameters<typeof makeNode>[0]> = {}) {
  // The fixture factory does not carry `fromComponent`, the field the parser stamps on every inlined node.
  return { ...makeNode({ id, moduleId: 'base.text', props, inlineStyles: { opacity: 0.8 }, ...extra }), fromComponent: 'Card' }
}

function page(overrides: { aProps?: Record<string, unknown>; aInstance?: Record<string, unknown>; aExtra?: Partial<Parameters<typeof makeNode>[0]> } = {}): Page {
  return makePage({
    id: PAGE_ID,
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.container', children: [CARD_A, CARD_B] }),
      [CARD_A]: instance(CARD_A, 'One', overrides.aInstance, [HEAD_A]),
      [CARD_B]: instance(CARD_B, 'Two', {}, [HEAD_B]),
      [HEAD_A]: heading(HEAD_A, overrides.aProps, overrides.aExtra),
      [HEAD_B]: heading(HEAD_B),
    },
  })
}

/** The board after the write landed: the first Card passes `heading="New"` and reads it at its own call site. */
function pageAfterOverride(): Page {
  return page({
    aInstance: { heading: 'New' },
    aProps: { text: 'New', tag: 'h2' },
    aExtra: { textOrigin: { rel: 'pages/Home.tsx', line: 5, col: 30 } },
  })
}

interface SaveAnswer {
  written?: number
  undoToken?: string
  refusals?: { nodeId: string; kind: string; reason: string; message: string }[]
  pages?: Page[]
}

let originalFetch: typeof globalThis.fetch
let unregisterSave: (() => void) | null = null
let patchListener: ((evt: Event) => void) | null = null
let saveCalls: { edits: Record<string, unknown>[]; sequence?: boolean }[] = []
let release: (() => void) | null = null

/** Answers each `/save` from `answers`; with `gate`, the first answer waits until `release()`. */
function stubFetch(answers: SaveAnswer[], gate = false): void {
  let call = 0
  const gated = gate ? new Promise<void>((resolve) => { release = resolve }) : null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0]
    if (path === '/admin/api/studio/save') {
      saveCalls.push(init?.body ? JSON.parse(String(init.body)) : { edits: [] })
      const answer = answers[Math.min(call, answers.length - 1)] ?? {}
      if (call === 0 && gated) await gated
      call += 1
      const written = answer.written ?? (answer.refusals ? 0 : 1)
      return new Response(
        JSON.stringify({
          ok: true,
          written,
          skipped: answer.refusals?.length ?? 0,
          refusals: answer.refusals ?? [],
          shifted: written > 0,
          sharedComponents: true,
          touchedFiles: ['pages/Home.tsx', 'components/Card.tsx'],
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
      const answer = answers[Math.min(call - 1, answers.length - 1)] ?? {}
      const pages = answer.pages ?? [pageAfterOverride()]
      const lines = [
        {
          kind: 'meta',
          dir: '/tmp/studio-test',
          projectName: 'studio-test',
          componentSources: {},
          styleRules: {},
          styleRuleSources: {},
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
const headText = (id: string) => (store().site!.pages[0]!.nodes[id]!.props as { text: string }).text

function load(p: Page): void {
  resetLoadedValues([p])
  store().loadSite(makeSite({ pages: [p] }))
  store().setActivePage(PAGE_ID)
}

beforeEach(() => {
  __resetToastBusForTests()
  resetStructuralCommitQueue()
  originalFetch = globalThis.fetch
  saveCalls = []
  release = null
  unregisterSave = registerEditorSave(async () => {})
  setStudioLoadedDir('/tmp/studio-test')
  load(page())
  useEditorStore.setState({ mainEditComponent: null } as Parameters<typeof useEditorStore.setState>[0])
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
  resetStructuralCommitQueue()
  store().clearSite()
})

describe('a text edit inside a component instance', () => {
  it('shows at once, is held back from the autosave diff, posts ONE expose-prop, and is ONE undo step', async () => {
    stubFetch([{ undoToken: TOKEN, pages: [pageAfterOverride()] }, { pages: [page()] }], true)
    store().updateNodeProps(HEAD_A, { text: 'New' })

    // The canvas: this instance shows it right away, the other does not.
    expect(headText(HEAD_A)).toBe('New')
    expect(headText(HEAD_B)).toBe('Current')
    // Not a history entry and not dirty: the real entry is the write landing.
    expect(store().canUndo).toBe(false)
    // The hold: the autosave diff must not write it to the component while the override is on the wire.
    expect(collectNodeDiffEdits(store().site!.pages, undefined).edits).toEqual([])

    await waitFor(() => saveCalls.length === 1)
    expect(saveCalls[0]!.edits).toEqual([
      { kind: 'expose-prop', nodeId: HEAD_A, overrides: [{ target: { kind: 'text' }, propName: 'heading', value: 'New' }] },
    ])
    release?.()
    await waitFor(() => currentToasts().some((candidate) => candidate.title === 'Changed on this Card only'))
    expect(store().canUndo).toBe(true)

    // Info toast with the explicit all-instances way out.
    const toast = currentToasts().find((candidate) => candidate.title === 'Changed on this Card only')
    expect(toast?.kind).toBe('info')
    expect(toast?.action?.label).toBe('Apply to all (2)')
    expect(headText(HEAD_A)).toBe('New')

    // ⌘Z is the journal's restore — one step, both files.
    store().undo()
    await waitFor(() => saveCalls.length === 2)
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'restore', nodeId: `undo-journal:${TOKEN}`, token: TOKEN }])
  })

  it('"Apply to all" posts promote-override through an element of the instance, with the prop the call site gained', async () => {
    stubFetch([{ undoToken: TOKEN, pages: [pageAfterOverride()] }, { undoToken: 'b'.repeat(32), pages: [page()] }])
    store().updateNodeProps(HEAD_A, { text: 'New' })
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Changed on this Card only'))
    const toast = currentToasts().find((candidate) => candidate.title === 'Changed on this Card only')!
    await toast.action!.onSelect()
    expect(saveCalls).toHaveLength(2)
    expect(saveCalls[1]!.edits).toEqual([{ kind: 'promote-override', nodeId: HEAD_A, propNames: ['heading'] }])
  })
})

describe('an inline-style edit inside a component instance', () => {
  it('goes out as a style override with a numeric value kept numeric', async () => {
    stubFetch([{ undoToken: TOKEN }])
    store().setNodeInlineStyles(HEAD_A, { opacity: 0.4 })
    expect((store().site!.pages[0]!.nodes[HEAD_A]!.inlineStyles as { opacity: number }).opacity).toBe(0.4)
    await waitFor(() => saveCalls.length === 1)
    expect(saveCalls[0]!.edits).toEqual([
      { kind: 'expose-prop', nodeId: HEAD_A, overrides: [{ target: { kind: 'style', property: 'opacity' }, propName: 'opacityValue', value: 0.4 }] },
    ])
  })
})

describe('single-element bulk writes are the single-element write', () => {
  it('a canvas gesture that writes one node through the bulk actions is an override too', async () => {
    stubFetch([{ undoToken: TOKEN }])
    store().setNodesInlineStylesPerNode([{ nodeId: HEAD_A, patch: { opacity: 0.2 } }])
    await waitFor(() => saveCalls.length === 1)
    expect(saveCalls[0]!.edits[0]).toMatchObject({ kind: 'expose-prop', nodeId: HEAD_A })
    store().setNodesInlineStyles([HEAD_B], { opacity: 0.3 })
    await waitFor(() => saveCalls.length === 2)
    expect(saveCalls[1]!.edits[0]).toMatchObject({ kind: 'expose-prop', nodeId: HEAD_B })
  })

  it('a multi-node write stays the ordinary one', async () => {
    stubFetch([{}])
    store().setNodesInlineStyles([HEAD_A, HEAD_B], { opacity: 0.3 })
    expect(saveCalls).toHaveLength(0)
    expect(store().canUndo).toBe(true)
  })
})

describe('what the codemod cannot prove keeps today\'s behaviour, with the reason', () => {
  it('a refusal the codemod names takes the preview back, applies the ordinary edit, and says why in one sentence', async () => {
    stubFetch([{ refusals: [{ nodeId: HEAD_A, kind: 'expose-prop', reason: 'call-site-spread', message: 'A <Card> spreads an object.' }] }])
    store().updateNodeProps(HEAD_A, { text: 'New' })
    await waitFor(() => currentToasts().some((toast) => toast.title === 'Not limited to this instance'))
    const toast = currentToasts().find((candidate) => candidate.title === 'Not limited to this instance')!
    expect(toast.body).toBe("Some Card spreads an object of props, which might already carry the new prop's name, so this changes every Card.")
    // The ordinary write: a real history entry, a dirty tree, and the autosave diff writes the component.
    expect(headText(HEAD_A)).toBe('New')
    expect(store().canUndo).toBe(true)
    const diff = collectNodeDiffEdits(store().site!.pages, undefined).edits
    expect(diff).toEqual([{ kind: 'text', nodeId: HEAD_A, text: 'New' }])
    expect(saveCalls).toHaveLength(1)
  })

  it('a style the component does not state is the ordinary edit at once — nothing is posted', async () => {
    stubFetch([{}])
    store().setNodeInlineStyles(HEAD_A, { margin: '4px' })
    expect((store().site!.pages[0]!.nodes[HEAD_A]!.inlineStyles as { margin: string }).margin).toBe('4px')
    expect(saveCalls).toHaveLength(0)
    const toast = currentToasts().find((candidate) => candidate.title === 'Not limited to this instance')
    expect(toast?.body).toBe('Card does not set `margin` on that element, so this changes every Card.')
  })

  it('"Edit main component" steps aside: the same edit is the ordinary one and changes every instance', async () => {
    stubFetch([{}])
    store().setMainEditComponent('Card')
    store().updateNodeProps(HEAD_A, { text: 'New' })
    expect(headText(HEAD_A)).toBe('New')
    expect(store().canUndo).toBe(true)
    expect(saveCalls).toHaveLength(0)
    expect(currentToasts()).toHaveLength(0)
    expect(collectNodeDiffEdits(store().site!.pages, undefined).edits).toEqual([{ kind: 'text', nodeId: HEAD_A, text: 'New' }])
  })

  it('a text the call site already owns is an ordinary, instance-local edit', async () => {
    load(pageAfterOverride())
    stubFetch([{}])
    store().updateNodeProps(HEAD_A, { text: 'Newer' })
    expect(saveCalls).toHaveLength(0)
    expect(store().canUndo).toBe(true)
    expect(currentToasts()).toHaveLength(0)
  })

  it('a node outside any component is never the router\'s business', async () => {
    stubFetch([{}])
    store().updateNodeProps(ROOT_ID, { tag: 'section' })
    expect(saveCalls).toHaveLength(0)
    expect(currentToasts()).toHaveLength(0)
  })
})
