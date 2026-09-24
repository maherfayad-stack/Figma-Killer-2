/**
 * P3-C (ERR-14, ERR-15) — a new class's stylesheet is the editor's choice,
 * never a question and never a refusal.
 *
 * ERR-14: with two or more hand-editable stylesheets and none co-located with
 * the class's page, the planner refused `ambiguous-stylesheet` and the save
 * opened a "Which stylesheet should this class live in?" modal about two
 * seconds after the first keystroke — from autosave, while the user was still
 * typing. Every candidate IS a real write target; which one is something the
 * editor can decide. Now it does, by a stated order (`rankCandidateStylesheets`):
 * the stylesheet written last, a global sheet over another page's module, the
 * nearest, the main one, then alphabetical — and it remembers the answer per
 * rule, so the save, the baseline and the panel agree.
 *
 * ERR-15: with no stylesheet at all and no page to put one beside, the planner
 * refused `no-editable-stylesheet` and toasted "Style not saved to source".
 * Now it asks the server to create one beside the app's entry module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import type { StyleRule } from '@core/page-tree'
import { reportStyleRulePlanRefusals, resetRefusalToasts } from '@site/studio/refusalToasts'
import {
  STUDIO_BREAKPOINT_ID,
  collectStyleRuleEdits,
  noteStylesheetWritten,
  resetCssDestinationMemory,
  resolveCssInsertDestination,
  setOpenPageFile,
  setStudioStyleRuleSources,
} from '@site/studio/styleRuleWriteback'

const RULE_ID = 'nanoid-promo'

const TWO_STYLESHEETS = {
  a: { file: 'src/styles/base.css', selector: '.a' },
  b: { file: 'src/styles/marketing.css', selector: '.b' },
}

function newRule(id = RULE_ID, name = 'promo-banner'): StyleRule {
  return {
    id,
    kind: 'class',
    name,
    selector: `.${name}`,
    styles: {},
    contextStyles: { [STUDIO_BREAKPOINT_ID]: { color: 'tomato' } },
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  } as StyleRule
}

function toasts(): ReadonlyArray<Toast> {
  let captured: ReadonlyArray<Toast> = []
  const unsubscribe = subscribeToasts((next) => {
    captured = next
  })
  unsubscribe()
  return captured
}

beforeEach(() => {
  setStudioStyleRuleSources({}, {})
  setOpenPageFile(null)
  resetCssDestinationMemory()
  resetRefusalToasts()
  __resetToastBusForTests()
})

afterEach(() => {
  __resetToastBusForTests()
})

describe('ERR-14 — several stylesheets: Studio chooses, and says nothing', () => {
  beforeEach(() => {
    setStudioStyleRuleSources(TWO_STYLESHEETS, {})
    // Neither stylesheet is co-located with the page on screen — the case that
    // used to open the modal.
    setOpenPageFile('src/screens/Billing.jsx')
  })

  it('inserts the rule into one stylesheet and reports nothing', () => {
    const plan = collectStyleRuleEdits({ [RULE_ID]: newRule() })
    reportStyleRulePlanRefusals(plan)

    expect(plan.edits).toEqual([
      {
        kind: 'css',
        op: 'insert',
        nodeId: 'css:insert:src/styles/base.css#.promo-banner',
        file: 'src/styles/base.css',
        selector: '.promo-banner',
        declarations: { color: 'tomato' },
      },
    ])
    expect(plan.unmapped).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('names the stylesheets it chose over', () => {
    expect(resolveCssInsertDestination(newRule())).toEqual({
      kind: 'existing',
      file: 'src/styles/base.css',
      alternatives: ['src/styles/marketing.css'],
    })
  })

  it('prefers the stylesheet the user wrote to last', () => {
    noteStylesheetWritten('src/styles/marketing.css')
    expect(resolveCssInsertDestination(newRule())).toMatchObject({ file: 'src/styles/marketing.css' })
  })

  it('keeps a rule’s first answer for the session, so the save and the baseline agree', () => {
    expect(resolveCssInsertDestination(newRule())).toMatchObject({ file: 'src/styles/base.css' })
    noteStylesheetWritten('src/styles/marketing.css')
    expect(resolveCssInsertDestination(newRule())).toMatchObject({ file: 'src/styles/base.css' })
    // A different new class does follow the last write.
    expect(resolveCssInsertDestination(newRule('nanoid-other', 'other'))).toMatchObject({ file: 'src/styles/marketing.css' })
  })
})

describe('ERR-14 — the ranking', () => {
  it('a global stylesheet beats another page’s CSS Module', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'pages/Onboarding.module.css', selector: '.a' },
        b: { file: 'src/index.css', selector: '.b' },
      },
      {},
    )
    setOpenPageFile('pages/Home.tsx')
    expect(resolveCssInsertDestination(newRule())).toMatchObject({ file: 'src/index.css' })
  })

  it('then the nearest to the class’s page', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'styles/app.css', selector: '.a' },
        b: { file: 'src/screens/shared.css', selector: '.b' },
      },
      {},
    )
    setOpenPageFile('src/screens/Billing.jsx')
    expect(resolveCssInsertDestination(newRule())).toMatchObject({ file: 'src/screens/shared.css' })
  })

  it('then the one holding the most rules', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'styles/z-main.css', selector: '.a' },
        b: { file: 'styles/z-main.css', selector: '.b' },
        c: { file: 'styles/a-extra.css', selector: '.c' },
      },
      {},
    )
    expect(resolveCssInsertDestination(newRule())).toMatchObject({ file: 'styles/z-main.css' })
  })

  it('a stylesheet co-located with the class’s page still wins outright', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'src/index.css', selector: '.a' },
        b: { file: 'pages/Home.module.css', selector: '.b' },
      },
      {},
    )
    noteStylesheetWritten('src/index.css')
    setOpenPageFile('pages/Home.tsx')
    expect(resolveCssInsertDestination(newRule())).toEqual({
      kind: 'existing',
      file: 'pages/Home.module.css',
      alternatives: [],
    })
  })
})

describe('ERR-15 — no stylesheet and no page: create one at the app entry', () => {
  it('plans a create with no page, and reports nothing', () => {
    const plan = collectStyleRuleEdits({ [RULE_ID]: newRule() })
    reportStyleRulePlanRefusals(plan)

    expect(plan.edits).toEqual([
      {
        kind: 'css',
        op: 'create',
        nodeId: `css:create:${RULE_ID}`,
        selector: '.promo-banner',
        declarations: { color: 'tomato' },
      },
    ])
    expect(toasts()).toEqual([])
  })

  it('with a page on screen, creates beside the page as before', () => {
    setOpenPageFile('pages/Home.tsx')
    expect(collectStyleRuleEdits({ [RULE_ID]: newRule() }).edits).toMatchObject([
      { op: 'create', pageFile: 'pages/Home.tsx' },
    ])
  })
})
