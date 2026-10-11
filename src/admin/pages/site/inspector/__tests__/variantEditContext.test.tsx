/**
 * The variant edit context in the inspector (CV-4): the selected element of a
 * component, the main-component mode, the catalog's bindings and the rules the
 * board loaded come together in `useSelectionModel().writeTargetFor`.
 *
 * Proven against the real hook and a mocked `/components` catalog. The rule
 * itself is covered on real projects by `server/handlers/__tests__/
 * studioVariantStyles.test.ts`; this file covers the wiring: when the context
 * is active, where it points, and that it never falls back to the base rule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { useSelectionModel } from '../selectionModel'
import { callSiteIdOf, findStyleRuleIdForSource } from '../variantEditContext'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
import '@modules/base/index'

const originalFetch = globalThis.fetch

const CALL_SITE = 'src/pages/Home.tsx:5:3'
const ROOT_EL = `${CALL_SITE}~src/components/Button.tsx:6:10`
const INNER_EL = `${CALL_SITE}~src/components/Button.tsx:7:12`

const RANGE = (line: number) => ({ file: 'src/components/Button.css', line, column: 1, endLine: line + 2, endColumn: 2 })

const CLASS_BINDING = {
  kind: 'css-module-class',
  scope: 'global',
  expr: '`btn btn-${variant}`',
  classPrefix: 'btn-',
  classSuffix: '',
  element: { line: 6, column: 10 },
  range: { file: 'src/components/Button.tsx', line: 6, column: 30, endLine: 6, endColumn: 55 },
  rules: [
    { member: 'primary', selector: '.btn-primary', range: RANGE(1) },
    { member: 'ghost', selector: '.btn-ghost', range: RANGE(5) },
  ],
}

const OPAQUE_BINDING = {
  kind: 'opaque',
  file: 'src/components/Button.tsx',
  line: 4,
  element: { line: 6, column: 10 },
  reason: '`variant` is used in computed code at line 4',
}

let binding: unknown = CLASS_BINDING

function rule(id: string, selector: string, styles: Record<string, string>): StyleRule {
  return { id, name: selector.slice(1), kind: 'class', selector, order: 0, styles, contextStyles: {}, createdAt: 0, updatedAt: 0 } as StyleRule
}

function seed(options: { gallery?: boolean } = {}) {
  const callSite = makeNode({
    id: CALL_SITE,
    moduleId: 'studio.instance',
    children: [ROOT_EL],
    props: { componentName: 'Button', source: 'local', sourceFile: 'src/components/Button.tsx', callSiteProps: { variant: 'ghost' } },
  })
  const root = makeNode({ id: ROOT_EL, moduleId: 'base.button', fromComponent: 'Button', classIds: ['sc-btn', 'sc-ghost'], children: [INNER_EL] })
  const inner = makeNode({ id: INNER_EL, moduleId: 'base.div', fromComponent: 'Button', classIds: ['sc-btn'] })
  const body = makeNode({ id: 'page-1:body', moduleId: 'base.body', children: options.gallery ? ['component-gallery:page-1:grid', CALL_SITE] : [CALL_SITE] })
  const grid = makeNode({ id: 'component-gallery:page-1:grid', moduleId: 'base.div' })
  const nodes = { [body.id]: body, [grid.id]: grid, [callSite.id]: callSite, [root.id]: root, [inner.id]: inner }
  const page = makePage({ id: 'page-1', rootNodeId: body.id, nodes })
  const site = makeSite({
    pages: [page],
    styleRules: {
      'sc-btn': rule('sc-btn', '.btn', { color: 'black', padding: '4px' }),
      'sc-ghost': rule('sc-ghost', '.btn-ghost', { background: 'transparent' }),
    },
  })
  setStudioStyleRuleSources(
    {
      'sc-btn': { file: 'src/components/Button.css', selector: '.btn' },
      'sc-ghost': { file: 'src/components/Button.css', selector: '.btn-ghost' },
    },
    {},
  )
  useEditorStore.setState({
    site,
    activePageId: page.id,
    activeDocument: null,
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    selectedNodeId: ROOT_EL,
    selectedNodeIds: [ROOT_EL],
    mainEditComponent: null,
    variantEditAxis: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  localStorage.clear()
  binding = CLASS_BINDING
  invalidateLocalComponentCatalog()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/admin/api/studio/components')) {
      return new Response(
        JSON.stringify({
          components: [
            {
              name: 'Button',
              file: 'src/components/Button.tsx',
              exportName: 'Button',
              isDefaultExport: false,
              line: 3,
              column: 17,
              role: 'component',
              props: [
                { name: 'label', kind: { kind: 'string' }, required: true },
                { name: 'variant', kind: { kind: 'enum', values: ['primary', 'ghost'] }, required: false, defaultValue: 'primary', binding },
              ],
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  setStudioStyleRuleSources({}, {})
})

describe('callSiteIdOf', () => {
  it('is everything before the LAST separator, so a nested component names its own call site', () => {
    expect(callSiteIdOf('p.tsx:5:3~a/Card.tsx:2:2~a/Button.tsx:6:10')).toBe('p.tsx:5:3~a/Card.tsx:2:2')
    expect(callSiteIdOf('p.tsx:5:3')).toBeNull()
  })
})

describe('findStyleRuleIdForSource', () => {
  const sources = {
    a: { file: 'x.css', selector: ".k[data-v='b']" },
    b: { file: 'y.css', selector: '.k' },
    c: { file: 'x.css', selector: '.one,  .two' },
  }
  it('matches by file and selector, ignoring quote style and spacing', () => {
    expect(findStyleRuleIdForSource(sources, { file: 'x.css', selector: '.k[data-v="b"]' })).toBe('a')
    expect(findStyleRuleIdForSource(sources, { file: 'x.css', selector: '.two' })).toBe('c')
  })
  it('never matches a rule of another file', () => {
    expect(findStyleRuleIdForSource(sources, { file: 'z.css', selector: '.k' })).toBeNull()
    expect(findStyleRuleIdForSource(sources, { file: 'y.css', selector: '.k' })).toBe('b')
  })
})

describe('useSelectionModel — the variant edit context', () => {
  it('is off by default: an edit goes where the cascade says (the base rule that sets colour)', () => {
    seed()
    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.variantContext).toBeNull()
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'class', classId: 'sc-btn', selector: '.btn' })
  })

  it('"Edit main component": the same edit lands in the shown variant rule, never in .btn', async () => {
    seed()
    useEditorStore.setState({ mainEditComponent: 'Button' })
    const { result } = renderHook(() => useSelectionModel())
    await waitFor(() => expect(result.current.variantContext).not.toBeNull())
    expect(result.current.variantContext?.chosen).toMatchObject({ kind: 'rule', prop: 'variant', member: 'ghost', selector: '.btn-ghost', label: 'Editing variant ghost: .btn-ghost in Button.css' })
    expect(result.current.variantRuleId).toBe('sc-ghost')
    // colour is set by .btn only, yet it is written to .btn-ghost; so is a property nobody sets
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'class', classId: 'sc-ghost', selector: '.btn-ghost' })
    expect(result.current.writeTargetFor('margin')).toEqual({ kind: 'class', classId: 'sc-ghost', selector: '.btn-ghost' })
    // the inline layer is never the answer inside a variant context
    expect(result.current.inlineWritable).toBe(true)
    expect(result.current.writeTargetFor('padding', { values: ['2px'] }).kind).toBe('class')
  })

  it('a gallery cell is the main component by construction: no mode needed', async () => {
    seed({ gallery: true })
    const { result } = renderHook(() => useSelectionModel())
    await waitFor(() => expect(result.current.variantContext).not.toBeNull())
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'class', classId: 'sc-ghost', selector: '.btn-ghost' })
  })

  it('clearing only reaches what the variant rule declares', async () => {
    seed({ gallery: true })
    const { result } = renderHook(() => useSelectionModel())
    await waitFor(() => expect(result.current.variantContext).not.toBeNull())
    expect(result.current.writeTargetFor('background', { existing: true })).toEqual({ kind: 'class', classId: 'sc-ghost', selector: '.btn-ghost' })
    expect(result.current.writeTargetFor('color', { existing: true })).toEqual({ kind: 'none', reason: '.btn-ghost does not set color.' })
  })

  it('an element the variant prop does not style keeps the ordinary rules', async () => {
    seed({ gallery: true })
    useEditorStore.setState({ selectedNodeId: INNER_EL, selectedNodeIds: [INNER_EL] })
    const { result } = renderHook(() => useSelectionModel())
    // give the catalog time to arrive: the answer must stay null, not flip
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.variantContext).toBeNull()
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'class', classId: 'sc-btn', selector: '.btn' })
  })

  it('a multi-selection never gets one', async () => {
    seed({ gallery: true })
    useEditorStore.setState({ selectedNodeIds: [ROOT_EL, INNER_EL] })
    const { result } = renderHook(() => useSelectionModel())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.variantContext).toBeNull()
  })

  it('an opaque binding refuses by name with the remedy, and writes nowhere', async () => {
    binding = OPAQUE_BINDING
    seed({ gallery: true })
    const { result } = renderHook(() => useSelectionModel())
    await waitFor(() => expect(result.current.variantContext).not.toBeNull())
    const target = result.current.writeTargetFor('color')
    expect(target.kind).toBe('none')
    if (target.kind !== 'none') throw new Error('unreachable')
    expect(target.reason).toContain('variant ghost')
    expect(target.reason).toContain('src/components/Button.tsx:4')
    expect(target.reason).toContain('Open src/components/Button.tsx:4')
    expect(result.current.writeTargetFor('color', { existing: true }).kind).toBe('none')
  })

  it('a variant rule the board did not load is a refusal that says so, not a fallback to .btn', async () => {
    seed({ gallery: true })
    setStudioStyleRuleSources({ 'sc-btn': { file: 'src/components/Button.css', selector: '.btn' } }, {})
    const { result } = renderHook(() => useSelectionModel())
    await waitFor(() => expect(result.current.variantContext).not.toBeNull())
    expect(result.current.variantRuleId).toBeNull()
    const target = result.current.writeTargetFor('color')
    expect(target.kind).toBe('none')
    expect(result.current.variantBlocker).toContain('.btn-ghost')
  })
})
