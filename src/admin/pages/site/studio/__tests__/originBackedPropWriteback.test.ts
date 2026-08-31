/**
 * Origin-backed PROP writeback — the dangerous half.
 *
 * `isPropWritableToSource` unlocks a code-valued prop whose literal the
 * evaluator located, and it does so on one promise: that the write aims at
 * THAT literal, never at the JSX. Aiming at the JSX would emit
 * `title="Skip the taxi queue"` over `title={t.home.skipTheTaxiQueue}` —
 * silently deleting the i18n binding the user just spent an extraction
 * creating, and doing it during an autosave nobody asked for.
 *
 * So the assertion here is not "the edit happened" but "the edit is a
 * `literal` aimed at the origin, and there is no `prop` edit at all".
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { fsCodemodAdapter } from '../fsCodemodAdapter'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'

const originalFetch = globalThis.fetch

const ORIGIN = { rel: 'i18n/translations.ts', line: 21, col: 25 }

function stubFetch(saveCalls: Array<{ body: unknown }>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = (typeof input === 'string' ? input : input.toString()).split('?')[0]
    if (path === '/admin/api/studio/load') {
      const meta = {
        kind: 'meta',
        dir: '/tmp/studio-test',
        projectName: 'studio-test',
        componentSources: {},
        styleRules: {},
        styleRuleSources: {},
        conditions: [],
        vendorCss: '',
        trust: 'static',
        paletteHiddenModuleIds: [],
        pageCount: 0,
      }
      return new Response(JSON.stringify(meta) + '\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }
    if (path === '/admin/api/studio/framework') {
      return new Response(JSON.stringify({ framework: null }), { status: 200 })
    }
    if (path === '/admin/api/studio/save') {
      saveCalls.push({ body: init?.body ? JSON.parse(String(init.body)) : {} })
      return new Response(
        JSON.stringify({ ok: true, written: 1, skipped: 0, shifted: false, sharedComponents: false }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** A design-system node whose `title` reaches the JSX as `{t.home.skipTheTaxiQueue}`. */
function marketingCard(title: string) {
  return makeNode({
    id: 'pages/Home.tsx:70:9',
    moduleId: 'alm.MarketingCard',
    props: { title, type: 'solid' },
    codeProps: ['title'],
    resolvedProps: {
      title: {
        source: 't.home.skipTheTaxiQueue',
        note: 'dynamic key not statically known — showing the "en" branch',
        origin: ORIGIN,
      },
    },
  })
}

describe('editing a prop that resolved through a dictionary lookup', () => {
  it('writes the LITERAL at its origin, and never the JSX attribute', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    stubFetch(saveCalls)
    await fsCodemodAdapter.loadSite()

    const node = marketingCard('Skip the queue entirely')
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [node.id] })
    await fsCodemodAdapter.saveSite(
      makeSite({ pages: [makePage({ id: 'home', rootNodeId: root.id, nodes: { [root.id]: root, [node.id]: node } })] }),
    )

    expect(saveCalls).toHaveLength(1)
    const edits = (saveCalls[0]!.body as { edits: Array<{ kind: string; nodeId: string; text?: string; prop?: string }> }).edits

    const literal = edits.find((edit) => edit.kind === 'literal')
    expect(literal).toBeDefined()
    expect(literal!.nodeId).toBe(`${ORIGIN.rel}:${ORIGIN.line}:${ORIGIN.col}`)
    expect(literal!.text).toBe('Skip the queue entirely')

    // The invariant. A `prop` edit here would bake a string over the binding.
    expect(edits.some((edit) => edit.kind === 'prop' && edit.prop === 'title')).toBe(false)
  })

  it('still refuses a code-valued prop with no origin', async () => {
    const saveCalls: Array<{ body: unknown }> = []
    stubFetch(saveCalls)
    await fsCodemodAdapter.loadSite()

    const node = makeNode({
      id: 'pages/Home.tsx:70:9',
      moduleId: 'alm.MarketingCard',
      props: { className: 'changed' },
      codeProps: ['className'],
      resolvedProps: { className: { source: 'styles.card' } },
    })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [node.id] })
    await fsCodemodAdapter.saveSite(
      makeSite({ pages: [makePage({ id: 'home', rootNodeId: root.id, nodes: { [root.id]: root, [node.id]: node } })] }),
    )

    const edits = (saveCalls[0]?.body as { edits?: Array<{ kind: string; prop?: string }> })?.edits ?? []
    // No honest target exists, so nothing is written for it — neither shape.
    expect(edits.some((edit) => edit.prop === 'className')).toBe(false)
    expect(edits.some((edit) => edit.kind === 'literal')).toBe(false)
  })
})
