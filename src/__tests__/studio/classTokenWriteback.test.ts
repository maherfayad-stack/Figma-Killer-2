/**
 * `style-02`/`style-02` — what a class ASSIGNMENT writes into the user's JSX,
 * and where a brand-new class's declarations go.
 *
 * The bug these exist for: `collectClassNameEdits` used to write
 * `styleRules[id].name` as a literal `className` token, unconditionally. For a
 * class that came out of a `*.module.css` that name is Studio's OWN compiled
 * hash (`styleCompile.ts`'s `<fileBase>_<local>__<sha1-5>`), which matches
 * only inside Studio's canvas iframe. The write landed, the toast said
 * "saved", and the class did nothing in the user's app.
 *
 * ## Two corpora, on purpose
 *
 * The first `describe` uses the shape the eSIM/agent-authored corpus has
 * (`pages/<Name>.tsx` + `pages/<Name>.module.css`). The LAST one uses a
 * deliberately unrelated repo shape — a feature-folder layout with a single
 * global plain stylesheet — following `genericRepoShapes.test.ts`'s
 * discipline: a suite grown from one repo encodes that repo's habits, and
 * every generality bug in this area came from exactly that.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Page, StyleRule } from '@core/page-tree'
import { collectClassNameEdits } from '@site/studio/classNameWriteback'
import { buildClassPageIndex, resolveCssInsertDestination, setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { commitClassIdsBaseline, resetLoadedValues } from '@site/studio/loadedValuesBaseline'
import { makeNode, makePage } from '../fixtures'

function styleRule(overrides: Partial<StyleRule> & { id: string; name: string }): StyleRule {
  return {
    kind: 'class',
    selector: `.${overrides.name}`,
    styles: {},
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

/** One page holding one source-backed element, optionally already carrying classes. */
function pageWith(nodeId: string, classIds: string[] = []): Page {
  return makePage({
    id: 'p1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [nodeId] }),
      [nodeId]: makeNode({ id: nodeId, moduleId: 'base.container', label: 'Card', classIds }),
    },
  })
}

/** Loads a baseline where the node has NO classes, so assigning one is a drift. */
function baselineWithout(pages: Page[]): void {
  resetLoadedValues(pages)
}

beforeEach(() => {
  setStudioStyleRuleSources({}, {})
})

describe('a CSS-Modules class is attached as a binding, never as its compiled name', () => {
  const RULE_ID = 'sc-signup-socialbtn'
  // Exactly what `studioCss.ts` produces for a module rule: `name` is the
  // COMPILED class the canvas cascades on, `displayName` is the local name as
  // written in the file.
  const moduleRule = styleRule({
    id: RULE_ID,
    name: 'SignUp_socialBtn__a1b2c',
    displayName: 'socialBtn',
    selector: '.SignUp_socialBtn__a1b2c',
  })

  it('emits a module token pointing at the stylesheet and the LOCAL name', () => {
    const before = [pageWith('pages/SignUp.tsx:12:5')]
    baselineWithout(before)
    setStudioStyleRuleSources({ [RULE_ID]: { file: 'pages/SignUp.module.css', selector: '.socialBtn' } }, {})

    const plan = collectClassNameEdits([pageWith('pages/SignUp.tsx:12:5', [RULE_ID])], { [RULE_ID]: moduleRule }, {})

    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]!.add).toEqual([{ kind: 'module', file: 'pages/SignUp.module.css', local: 'socialBtn' }])
    // The regression that mattered: the hash must never reach the wire.
    expect(JSON.stringify(plan.edits)).not.toContain('SignUp_socialBtn__a1b2c')
    expect(plan.tokenRefusals).toHaveLength(0)
  })

  it('uses a plain literal for a :global() class inside a module file (never renamed, so no displayName)', () => {
    const globalRule = styleRule({ id: 'sc-global-active', name: 'is-active', selector: '.is-active' })
    baselineWithout([pageWith('pages/SignUp.tsx:12:5')])
    setStudioStyleRuleSources({ 'sc-global-active': { file: 'pages/SignUp.module.css', selector: '.is-active' } }, {})

    const plan = collectClassNameEdits(
      [pageWith('pages/SignUp.tsx:12:5', ['sc-global-active'])],
      { 'sc-global-active': globalRule },
      {},
    )

    expect(plan.edits[0]!.add).toEqual([{ kind: 'literal', token: 'is-active' }])
  })

  it('uses a plain literal for a rule whose source is an ordinary .css file', () => {
    const plainRule = styleRule({ id: 'sc-hero', name: 'hero', selector: '.hero' })
    baselineWithout([pageWith('pages/Home.tsx:3:1')])
    setStudioStyleRuleSources({ 'sc-hero': { file: 'pages/Home.css', selector: '.hero' } }, {})

    const plan = collectClassNameEdits([pageWith('pages/Home.tsx:3:1', ['sc-hero'])], { 'sc-hero': plainRule }, {})

    expect(plan.edits[0]!.add).toEqual([{ kind: 'literal', token: 'hero' }])
  })

  it('uses a plain literal for an unmapped IMPORTED rule — a Tailwind utility IS its own DOM name', () => {
    const utility = styleRule({ id: 'sc-bg-red-500', name: 'bg-red-500', selector: '.bg-red-500' })
    baselineWithout([pageWith('pages/Home.tsx:3:1')])

    const plan = collectClassNameEdits(
      [pageWith('pages/Home.tsx:3:1', ['sc-bg-red-500'])],
      { 'sc-bg-red-500': utility },
      {},
    )

    expect(plan.edits[0]!.add).toEqual([{ kind: 'literal', token: 'bg-red-500' }])
  })
})

describe('a class the editor authored takes the SAME destination its declarations will', () => {
  const NEW_ID = 'Ux7nQ2' // a nanoid — never the deterministic `sc-` prefix

  it('emits a module token when the destination stylesheet is a .module.css', () => {
    baselineWithout([pageWith('pages/Home.tsx:3:1')])
    setStudioStyleRuleSources({ 'sc-other': { file: 'pages/Home.module.css', selector: '.other' } }, {})
    const created = styleRule({ id: NEW_ID, name: 'promoBanner' })

    const plan = collectClassNameEdits([pageWith('pages/Home.tsx:3:1', [NEW_ID])], { [NEW_ID]: created }, {})

    expect(plan.edits[0]!.add).toEqual([{ kind: 'module', file: 'pages/Home.module.css', local: 'promoBanner' }])
  })

  // The honest guard. The SERVER decides a created stylesheet's name and
  // convention, so the client cannot know whether the class is reachable by
  // name — and it must not guess.
  it('REFUSES, and holds the node back, when the stylesheet is being created in this same save', () => {
    const pages = [pageWith('pages/Home.tsx:3:1')]
    baselineWithout(pages)
    setStudioStyleRuleSources({}, {})
    const created = styleRule({ id: NEW_ID, name: 'promoBanner' })
    const after = [pageWith('pages/Home.tsx:3:1', [NEW_ID])]

    const plan = collectClassNameEdits(after, { [NEW_ID]: created }, {})

    expect(plan.edits).toHaveLength(0)
    expect(plan.tokenRefusals).toHaveLength(1)
    expect(plan.tokenRefusals[0]!.reason).toBe('stylesheet-not-created-yet')
    expect(plan.refusedNodeIds).toEqual(['pages/Home.tsx:3:1'])

    // …and the baseline held back means the SAME assignment is offered again
    // on the next save rather than vanishing (`style-02`).
    commitClassIdsBaseline(after, plan.refusedNodeIds)
    setStudioStyleRuleSources({ [NEW_ID]: { file: 'pages/Home.module.css', selector: '.promoBanner' } }, {})
    const retry = collectClassNameEdits(after, { [NEW_ID]: created }, {})
    expect(retry.edits[0]!.add).toEqual([{ kind: 'module', file: 'pages/Home.module.css', local: 'promoBanner' }])
  })

  it('advances the baseline normally for a node whose tokens all resolved', () => {
    const after = [pageWith('pages/Home.tsx:3:1', ['sc-hero'])]
    baselineWithout([pageWith('pages/Home.tsx:3:1')])
    setStudioStyleRuleSources({ 'sc-hero': { file: 'pages/Home.css', selector: '.hero' } }, {})
    const rules = { 'sc-hero': styleRule({ id: 'sc-hero', name: 'hero' }) }

    expect(collectClassNameEdits(after, rules, {}).edits).toHaveLength(1)
    commitClassIdsBaseline(after, [])
    expect(collectClassNameEdits(after, rules, {}).edits).toHaveLength(0)
  })
})

describe('style-02 — a new class co-locates with the page it is USED on', () => {
  /**
   * THE BUG: the co-location step only ever consulted `rule.scope`, whose only
   * producer (`ensureNodeStyleClass`) has no non-test caller. So in a project
   * where every page owns a stylesheet, every new class hit the ambiguity
   * refusal: "Studio found 4 candidate stylesheets ... and will not guess".
   * The class is ASSIGNED to a node, and a node id decodes to its file.
   */
  const FOUR_SHEETS = {
    a: { file: 'pages/Home.module.css', selector: '.a' },
    b: { file: 'pages/Onboarding.module.css', selector: '.b' },
    c: { file: 'pages/SMS.module.css', selector: '.c' },
    d: { file: 'pages/SignUp.module.css', selector: '.d' },
  }

  it('resolves to the stylesheet beside the page the class is on, with no scope at all', () => {
    setStudioStyleRuleSources(FOUR_SHEETS, {})
    const index = buildClassPageIndex([pageWith('pages/Onboarding.tsx:9:3', ['new-1'])])

    expect(resolveCssInsertDestination(styleRule({ id: 'new-1', name: 'banner' }), index)).toEqual({
      ok: true,
      kind: 'existing',
      file: 'pages/Onboarding.module.css',
    })
  })

  it('still refuses when the same class is used on TWO pages — there is no single answer', () => {
    setStudioStyleRuleSources(FOUR_SHEETS, {})
    const index = buildClassPageIndex([
      pageWith('pages/Onboarding.tsx:9:3', ['new-1']),
      { ...pageWith('pages/SMS.tsx:4:2', ['new-1']), id: 'p2' },
    ])

    expect(index.has('new-1')).toBe(false)
    expect(resolveCssInsertDestination(styleRule({ id: 'new-1', name: 'banner' }), index)).toMatchObject({
      reason: 'ambiguous-stylesheet',
    })
  })
})

/**
 * A repo that shares NOTHING with the eSIM corpus: feature folders rather than
 * a flat `pages/` directory, `.jsx` rather than `.tsx`, and one global plain
 * stylesheet rather than a module per page. Everything here must work without
 * the co-location convention firing at all.
 */
describe('generic repo shape — feature folders, one global plain stylesheet', () => {
  it('sends a plain literal token and inserts into the single global stylesheet', () => {
    setStudioStyleRuleSources({ 'sc-btn': { file: 'src/styles/app.css', selector: '.btn' } }, {})
    baselineWithout([pageWith('src/features/checkout/CheckoutForm.jsx:41:7')])
    const created = styleRule({ id: 'kQ91zz', name: 'checkoutTotal' })
    const pages = [pageWith('src/features/checkout/CheckoutForm.jsx:41:7', ['kQ91zz'])]

    // The declarations go to the one editable stylesheet…
    expect(resolveCssInsertDestination(created, buildClassPageIndex(pages))).toEqual({
      ok: true,
      kind: 'existing',
      file: 'src/styles/app.css',
    })
    // …and the class attaches by name, because a plain `.css` class IS its
    // own DOM name.
    const plan = collectClassNameEdits(pages, { kQ91zz: created }, {})
    expect(plan.edits[0]!.add).toEqual([{ kind: 'literal', token: 'checkoutTotal' }])
    expect(plan.tokenRefusals).toHaveLength(0)
  })

  it('refuses rather than guessing when a feature folder has two candidate stylesheets and the class is on neither page', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'src/styles/app.css', selector: '.a' },
        b: { file: 'src/styles/print.css', selector: '.b' },
      },
      {},
    )
    const created = styleRule({ id: 'kQ91zz', name: 'checkoutTotal' })

    expect(resolveCssInsertDestination(created, new Map())).toMatchObject({ reason: 'ambiguous-stylesheet' })
  })
})
