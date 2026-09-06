/**
 * W4-4 Phase B — what the save loop does with a rule that came out of a
 * styled-component template, on both sides of the line.
 *
 * ## The bug the first `describe` exists for
 *
 * Phase A's own handoff named it (`parser-11`, landmine 1) and deliberately
 * did not fix it: a styled element's synthetic class exists in `node.classIds`
 * and in the canvas DOM, but there is NO `className` attribute in the `.tsx`
 * holding it — styled-components generates its class at runtime and
 * `Card_sc__a1b2c3` is a hash Studio computed. Removing that class in the CSS
 * Classes panel produced a `kind: 'class'` edit whose `remove` token
 * `setJsxClassName` could not find, so the codemod no-opped with
 * `{ ok: true }`, the file was untouched, and the canvas showed the class
 * gone. A canvas that disagrees with the file, reported as a success.
 *
 * Adding one was worse: it wrote Studio's own hash into the user's JSX, which
 * matches nothing outside Studio's iframe — exactly `style-02`'s CSS-Modules
 * bug, reached through a different door.
 *
 * ## And the second: a DECLARATION edit now writes
 *
 * The same rule that refuses a class token accepts a value change, because the
 * declaration IS hand-written in a `.tsx` the `styledStyleRuleSources` map
 * names. Adding or clearing one still refuses — that would mean editing the
 * SHAPE of a template the user wrote.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Page, StyleRule } from '@core/page-tree'
import { collectClassNameEdits } from '@site/studio/classNameWriteback'
import { collectStyleRuleEdits, commitBaseline, setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { resetLoadedValues } from '@site/studio/loadedValuesBaseline'
import { resolveClassCssEditability, classCssWriteLockReason } from '@site/panels/PropertiesPanel/classCssWritability'
import { makeNode, makePage } from '../fixtures'

/** The `sc-` id + synthetic class name shape `studioCss.ts` mints for a styled template's flattened CSS. */
const RULE_ID = 'sc-styledcard1'
const CLASS_NAME = 'Card_sc__a1b2c3'

const STYLED_SOURCES = {
  [RULE_ID]: { file: 'src/ui/Card.tsx', line: 7, col: 21, className: CLASS_NAME, componentName: 'Card' },
}

function styledRule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: RULE_ID,
    kind: 'class',
    name: CLASS_NAME,
    selector: `.${CLASS_NAME}`,
    styles: {},
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

function pageWith(classIds: string[]): Page {
  return makePage({
    id: 'p1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['src/ui/Card.tsx:12:5'] }),
      'src/ui/Card.tsx:12:5': makeNode({ id: 'src/ui/Card.tsx:12:5', moduleId: 'base.container', label: 'Card', classIds }),
    },
  })
}

beforeEach(() => {
  setStudioStyleRuleSources({}, {})
})

describe('a class token is REFUSED for a styled component, never silently no-opped', () => {
  it('refuses REMOVING the synthetic class, by name, instead of emitting an edit the codemod cannot land', () => {
    resetLoadedValues([pageWith([RULE_ID])])
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    const plan = collectClassNameEdits([pageWith([])], { [RULE_ID]: styledRule() }, {})

    // Before this fix: one `kind: 'class'` edit carrying a `remove` token of
    // `Card_sc__a1b2c3`, which `setJsxClassName` could not find — `{ ok: true }`,
    // file untouched, canvas showing the class gone.
    expect(plan.edits).toEqual([])
    expect(plan.tokenRefusals).toHaveLength(1)
    expect(plan.tokenRefusals[0]!.reason).toBe('styled-component-class')
    expect(plan.tokenRefusals[0]!.message).toContain("Card's own styling")
    // The node's baseline must be held back so the user's retry is attempted
    // again rather than diffing as "no change".
    expect(plan.refusedNodeIds).toEqual(['src/ui/Card.tsx:12:5'])
  })

  it('refuses ADDING it too — the hash matches nothing outside Studio’s own iframe', () => {
    resetLoadedValues([pageWith([])])
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    const plan = collectClassNameEdits([pageWith([RULE_ID])], { [RULE_ID]: styledRule() }, {})

    expect(plan.edits).toEqual([])
    expect(plan.tokenRefusals[0]!.reason).toBe('styled-component-class')
  })

  it('still writes an ordinary imported class token — the refusal is scoped to styled rules', () => {
    const plain = { ...styledRule({ id: 'sc-plain', name: 'card', selector: '.card' }) }
    resetLoadedValues([pageWith([])])
    setStudioStyleRuleSources({}, { 'sc-plain': plain }, { styledSources: STYLED_SOURCES })

    const page = makePage({
      id: 'p1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['src/ui/Card.tsx:12:5'] }),
        'src/ui/Card.tsx:12:5': makeNode({ id: 'src/ui/Card.tsx:12:5', moduleId: 'base.container', classIds: ['sc-plain'] }),
      },
    })
    const plan = collectClassNameEdits([page], { 'sc-plain': plain }, {})

    expect(plan.tokenRefusals).toEqual([])
    expect(plan.edits).toEqual([{ kind: 'class', nodeId: 'src/ui/Card.tsx:12:5', add: [{ kind: 'literal', token: 'card' }], remove: [] }])
  })
})

describe('a declaration VALUE change becomes a kind: styled edit', () => {
  it('targets the template’s own rel:line:col and carries the synthetic class + selector', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    const changed = styledRule({ contextStyles: { studio: { color: 'rebeccapurple' } } })
    const plan = collectStyleRuleEdits({ [RULE_ID]: changed })

    expect(plan.unmapped).toEqual([])
    expect(plan.edits).toEqual([
      {
        kind: 'styled',
        nodeId: 'src/ui/Card.tsx:7:21',
        className: CLASS_NAME,
        selector: `.${CLASS_NAME}`,
        property: 'color',
        value: 'rebeccapurple',
      },
    ])
    // Every declaration in one template shares the template's node id, so the
    // join back to rule ids is a LIST — one refusal there must hold back every
    // rule flattened out of that template.
    expect(plan.ruleIdsByNodeId['src/ui/Card.tsx:7:21']).toEqual([RULE_ID])
  })

  it('kebab-cases the property, exactly as the .css path does', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    const plan = collectStyleRuleEdits({ [RULE_ID]: styledRule({ contextStyles: { studio: { fontSize: '18px' } } }) })

    expect(plan.edits[0]).toMatchObject({ kind: 'styled', property: 'font-size', value: '18px' })
  })

  it('carries a real breakpoint override as a nested @media query', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    const plan = collectStyleRuleEdits(
      { [RULE_ID]: styledRule({ contextStyles: { mobile: { width: '90%' } } }) },
      [],
      { breakpoints: [{ id: 'mobile', label: 'Mobile', width: 480, mediaQuery: '(max-width: 480px)' }] },
    )

    expect(plan.edits[0]).toMatchObject({ kind: 'styled', property: 'width', value: '90%', atMedia: '(max-width: 480px)' })
  })

  it('REPORTS a cleared declaration instead of emitting one — deleting a line is not a value edit', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule({ styles: { color: 'red' } }) }, { styledSources: STYLED_SOURCES })

    const plan = collectStyleRuleEdits({ [RULE_ID]: styledRule({ styles: {} }) })

    expect(plan.edits).toEqual([])
    expect(plan.unmapped).toHaveLength(1)
    expect(plan.unmapped[0]!.reason).toContain('Card')
    expect(plan.unmapped[0]!.reason).toContain('deleting a line')
  })

  it('stops re-emitting once the baseline advances', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })
    const changed = { [RULE_ID]: styledRule({ contextStyles: { studio: { color: 'blue' } } }) }

    expect(collectStyleRuleEdits(changed).edits).toHaveLength(1)
    commitBaseline(changed)
    expect(collectStyleRuleEdits(changed).edits).toEqual([])
  })
})

describe('the pre-flight writability tier', () => {
  it('reports a styled rule as its own tier, naming the template’s file and component', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    expect(resolveClassCssEditability(styledRule())).toEqual({
      kind: 'styled-template',
      file: 'src/ui/Card.tsx',
      componentName: 'Card',
    })
  })

  it('does NOT lock the property rows — value edits reach disk', () => {
    setStudioStyleRuleSources({}, { [RULE_ID]: styledRule() }, { styledSources: STYLED_SOURCES })

    const editability = resolveClassCssEditability(styledRule())
    expect(classCssWriteLockReason(editability, { studioSession: true })).toBeNull()
  })

  it('falls back to unmapped for an imported rule that is NOT styled', () => {
    setStudioStyleRuleSources({}, {}, { styledSources: STYLED_SOURCES })

    expect(resolveClassCssEditability(styledRule({ id: 'sc-other', name: 'other', selector: '.other' }))).toEqual({ kind: 'unmapped' })
  })
})
