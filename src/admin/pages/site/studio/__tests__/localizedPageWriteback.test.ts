/**
 * localizedPageWriteback — WS-10 §4.4 (Phase 4)'s save path. The proof the
 * coordinator asked for by name: editing the SAME node id in the `en`
 * (default) frame and the `ar` (locale-variant) frame in one session must
 * produce TWO writes to TWO different literals, never one write that wins.
 *
 * Exercised through the REAL `fsCodemodAdapter.saveSite()` — the actual
 * code path a live autosave tick runs — not just the isolated collector
 * functions, so this is the true end-to-end proof of the save path, mirroring
 * `fsCodemodAdapter.test.ts`'s own integration style.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fsCodemodAdapter } from '../fsCodemodAdapter'
import { useEditorStore } from '@site/store/store'
import {
  resetLocalizedTextBaseline,
  watchLocalizedPagesForBaseline,
} from '../localizedPageWriteback'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
// Side-effect import: registers `base.text`'s `inlineTextEdit.prop` ('text')
// into the global registry — both the default-tree AND locale-variant
// literal-edit paths key off this.
import '@modules/base/text'

const originalFetch = globalThis.fetch

/** Same eSIM-shaped fixture the server-side proof (`localizedPage.test.ts`) uses: dictionary and index site in separate files, same LINE, different COLUMN — the shape that broke the locale probe's first draft. */
const EN_ORIGIN = { rel: 'i18n/translations.js', line: 2, col: 7 }
const AR_ORIGIN = { rel: 'i18n/translations.js', line: 2, col: 25 }

/** `duringSave` runs while the save POST is in flight — the window ERR-17 is about. */
function stubFetch(saveCalls: Array<{ body: unknown }>, duringSave?: () => void) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.split('?')[0]
    if (path === '/admin/api/studio/load') {
      const lines = [
        { kind: 'meta', dir: '/tmp/studio-test', projectName: 'studio-test', componentSources: {}, styleRules: {}, styleRuleSources: {}, styledStyleRuleSources: {}, conditions: [], vendorCss: '', authoredCss: '', trust: 'static', paletteHiddenModuleIds: [], pageCount: 0 },
      ]
      return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }
    if (path === '/admin/api/studio/framework') {
      return new Response(JSON.stringify({ framework: null, fonts: null }), { status: 200 })
    }
    if (path === '/admin/api/studio/save') {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      saveCalls.push({ body })
      duringSave?.()
      return new Response(
        JSON.stringify({ ok: true, written: body.edits?.length ?? 0, skipped: 0, shifted: false, sharedComponents: false }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

beforeEach(() => {
  resetLocalizedTextBaseline()
  useEditorStore.setState({
    localizedPages: {},
    localizedPageStatus: {},
  } as Parameters<typeof useEditorStore.setState>[0])
  watchLocalizedPagesForBaseline()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetLocalizedTextBaseline()
  useEditorStore.setState({ localizedPages: {}, localizedPageStatus: {} } as Parameters<typeof useEditorStore.setState>[0])
})

describe('a same-node-id edit in the en (default) frame and the ar (variant) frame produces two distinct writes', () => {
  it('two kind:"literal" edits, aimed at two different textOrigin locations — never one write that wins', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    stubFetch(saveCalls)

    // --- default (en) tree, loaded the normal way ---
    await fsCodemodAdapter.loadSite()

    // --- locale-variant (ar) tree: simulates `loadStudioPageInLocale`'s
    // output landing in the store via `ensureLocalizedPage` — the fetch
    // itself is proven server-side (`localizedPage.test.ts`); this test
    // starts from "the page has already arrived", which is what
    // `watchLocalizedPagesForBaseline`'s seeding actually observes.
    const arNode = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'مرحبا' }, textOrigin: AR_ORIGIN })
    const arRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [arNode.id] })
    const arPage = makePage({ id: 'home', rootNodeId: arRoot.id, nodes: { [arRoot.id]: arRoot, [arNode.id]: arNode } })
    useEditorStore.setState({
      localizedPages: { 'home::ar': arPage },
      localizedPageStatus: { 'home::ar': 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])

    // --- edit BOTH frames' copy of the SAME node id, in one session ---
    // en: through the normal `site.pages` path (what `updateNodeProps` would
    // produce — this test builds the post-edit `site` directly, matching
    // `fsCodemodAdapter.test.ts`'s own style of calling `saveSite` with an
    // already-edited document rather than driving the store's node actions).
    const enEditedNode = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'Hi Muhammad' }, textOrigin: EN_ORIGIN })
    const enRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [enEditedNode.id] })
    const site = makeSite({
      pages: [makePage({ id: 'home', rootNodeId: enRoot.id, nodes: { [enRoot.id]: enRoot, [enEditedNode.id]: enEditedNode } })],
    })

    // ar: through the REAL store mutation a locale-variant inline-edit
    // session uses (`inlineEditSlice.ts`'s `applyInlineEditValue` calls
    // exactly this action for a `localeOverride` session).
    useEditorStore.getState().updateLocalizedNodeText('home', 'ar', 'headline', 'text', 'مرحبا جدًا')

    await fsCodemodAdapter.saveSite(site)

    expect(saveCalls).toHaveLength(1)
    const edits = (saveCalls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: string }> }).edits
    const literalEdits = edits.filter((e) => e.kind === 'literal')
    expect(literalEdits).toHaveLength(2)

    const enEdit = literalEdits.find((e) => e.text === 'Hi Muhammad')
    const arEdit = literalEdits.find((e) => e.text === 'مرحبا جدًا')
    expect(enEdit).toBeDefined()
    expect(arEdit).toBeDefined()

    // The write-target invariant: two DIFFERENT `nodeId` strings (each is
    // `${rel}:${line}:${col}` — the literal's OWN origin), even though both
    // edits came from the exact same page/node id (`home`/`headline`). One
    // write does NOT win over the other; they are independent targets.
    expect(enEdit!.nodeId).toBe(`${EN_ORIGIN.rel}:${EN_ORIGIN.line}:${EN_ORIGIN.col}`)
    expect(arEdit!.nodeId).toBe(`${AR_ORIGIN.rel}:${AR_ORIGIN.line}:${AR_ORIGIN.col}`)
    expect(enEdit!.nodeId).not.toBe(arEdit!.nodeId)
  })

  it('a SECOND save tick re-sends nothing for either locale once both baselines have advanced', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    stubFetch(saveCalls)
    await fsCodemodAdapter.loadSite()

    const arNode = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'مرحبا' }, textOrigin: AR_ORIGIN })
    const arRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [arNode.id] })
    const arPage = makePage({ id: 'home', rootNodeId: arRoot.id, nodes: { [arRoot.id]: arRoot, [arNode.id]: arNode } })
    useEditorStore.setState({
      localizedPages: { 'home::ar': arPage },
      localizedPageStatus: { 'home::ar': 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().updateLocalizedNodeText('home', 'ar', 'headline', 'text', 'مرحبا جدًا')

    const site = makeSite()
    await fsCodemodAdapter.saveSite(site) // first tick: sends the ar edit
    expect(saveCalls).toHaveLength(1)

    await fsCodemodAdapter.saveSite(site) // second tick: nothing changed since
    expect(saveCalls).toHaveLength(1) // no new POST — baseline already caught up
  })

  it('fetching an ar variant with NO edit yet contributes zero edits — a mere fetch is not a change', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    stubFetch(saveCalls)
    await fsCodemodAdapter.loadSite()

    const arNode = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'مرحبا' }, textOrigin: AR_ORIGIN })
    const arRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [arNode.id] })
    const arPage = makePage({ id: 'home', rootNodeId: arRoot.id, nodes: { [arRoot.id]: arRoot, [arNode.id]: arNode } })
    useEditorStore.setState({
      localizedPages: { 'home::ar': arPage },
      localizedPageStatus: { 'home::ar': 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])
    // No `updateLocalizedNodeText` call — the page just arrived, untouched.

    await fsCodemodAdapter.saveSite(makeSite())
    expect(saveCalls).toHaveLength(0)
  })
})

describe('ERR-17 — the baseline advances to what was SENT, never to what the store holds after the POST', () => {
  const FR_ORIGIN = { rel: 'i18n/translations.js', line: 3, col: 7 }

  function frPage(text: string) {
    const node = makeNode({ id: 'headline', moduleId: 'base.text', props: { text }, textOrigin: FR_ORIGIN })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [node.id] })
    return makePage({ id: 'home', rootNodeId: root.id, nodes: { [root.id]: root, [node.id]: node } })
  }

  it('text typed while a save is in flight is sent by the NEXT save', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    let typedMidSave = false
    stubFetch(saveCalls, () => {
      if (typedMidSave) return
      typedMidSave = true
      useEditorStore.getState().updateLocalizedNodeText('home', 'fr', 'headline', 'text', 'Bonjour encore')
    })
    await fsCodemodAdapter.loadSite()
    useEditorStore.setState({
      localizedPages: { 'home::fr': frPage('Bonjour') },
      localizedPageStatus: { 'home::fr': 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().updateLocalizedNodeText('home', 'fr', 'headline', 'text', 'Bonjour tout le monde')

    await fsCodemodAdapter.saveSite(makeSite())
    await fsCodemodAdapter.saveSite(makeSite())

    const sentTexts = saveCalls.flatMap((call) => (call.body as { edits: Array<{ text?: string }> }).edits.map((edit) => edit.text))
    expect(sentTexts).toEqual(['Bonjour tout le monde', 'Bonjour encore'])
  })

  it('a locale page fetched while a save is in flight keeps its baseline, so its later edits still save', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    stubFetch(saveCalls, () => {
      // The `ar` fetch lands mid-save: `watchLocalizedPagesForBaseline` seeds it now.
      const current = useEditorStore.getState().localizedPages
      if (current['home::ar']) return
      const arNode = makeNode({ id: 'headline', moduleId: 'base.text', props: { text: 'Marhaba' }, textOrigin: AR_ORIGIN })
      const arRoot = makeNode({ id: 'page-root', moduleId: 'base.body', children: [arNode.id] })
      useEditorStore.setState({
        localizedPages: { ...current, 'home::ar': makePage({ id: 'home', rootNodeId: arRoot.id, nodes: { [arRoot.id]: arRoot, [arNode.id]: arNode } }) },
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    await fsCodemodAdapter.loadSite()
    useEditorStore.setState({
      localizedPages: { 'home::fr': frPage('Bonjour') },
      localizedPageStatus: { 'home::fr': 'ready' },
    } as Parameters<typeof useEditorStore.setState>[0])
    useEditorStore.getState().updateLocalizedNodeText('home', 'fr', 'headline', 'text', 'Salut')
    await fsCodemodAdapter.saveSite(makeSite())

    useEditorStore.getState().updateLocalizedNodeText('home', 'ar', 'headline', 'text', 'Ahlan')
    await fsCodemodAdapter.saveSite(makeSite())

    const second = (saveCalls[1]?.body as { edits: Array<{ nodeId: string; text?: string }> } | undefined)?.edits ?? []
    expect(second).toEqual([{ kind: 'literal', nodeId: `${AR_ORIGIN.rel}:${AR_ORIGIN.line}:${AR_ORIGIN.col}`, text: 'Ahlan' }])
  })
})
