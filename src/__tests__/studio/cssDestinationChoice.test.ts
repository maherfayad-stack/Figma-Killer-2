/**
 * Z8 — an ambiguous CSS destination reaches the user as a QUESTION.
 *
 * The refusal itself was already honest: N hand-editable stylesheets exist,
 * Studio will not guess, say so. What it was not was ANSWERABLE — it arrived
 * as a red toast naming four files, and there was nothing the user could do
 * about it inside the editor. This file pins the whole transport: the plan's
 * refusal becomes an `EditConstraint` with one remedy per candidate file, the
 * remedy opens `RefusalDialog` rather than the toast bus, clicking it pins the
 * destination and asks for a save, and the NEXT plan writes.
 *
 * The terminal half is pinned too, deliberately. `no-editable-stylesheet` has
 * zero candidates — there is no question to ask — so it must keep toasting. A
 * modal with no answer in it is worse than a sentence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import type { StyleRule } from '@core/page-tree'
import { explainCssRuleConstraint } from '@core/page-tree'
import { resolveConstraintAction } from '@site/store/constraintActions'
import type { StructuralRefusalDialogState } from '@site/store/slices/uiSlice'
import {
  reportStyleRulePlanRefusals,
  resetRefusalToasts,
  styleRulePlanTouchedSomething,
} from '@site/studio/refusalToasts'
import {
  STUDIO_BREAKPOINT_ID,
  collectStyleRuleEdits,
  setOpenPageFile,
  setStudioStyleRuleSources,
} from '@site/studio/styleRuleWriteback'

const RULE_ID = 'nanoid-promo'

const TWO_STYLESHEETS = {
  a: { file: 'src/styles/base.css', selector: '.a' },
  b: { file: 'src/styles/marketing.css', selector: '.b' },
}

function newRule(): StyleRule {
  return {
    id: RULE_ID,
    kind: 'class',
    name: 'promo-banner',
    selector: '.promo-banner',
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

/** Collects whatever the reporter would have opened `RefusalDialog` with. */
function dialogSpy(): { open: (dialog: StructuralRefusalDialogState) => void; opened: StructuralRefusalDialogState[] } {
  const opened: StructuralRefusalDialogState[] = []
  return { open: (dialog) => void opened.push(dialog), opened }
}

beforeEach(() => {
  setStudioStyleRuleSources({}, {})
  setOpenPageFile(null)
  resetRefusalToasts()
  __resetToastBusForTests()
})

afterEach(() => {
  __resetToastBusForTests()
})

describe('an ambiguous destination opens the dialog, never a toast', () => {
  beforeEach(() => {
    setStudioStyleRuleSources(TWO_STYLESHEETS, {})
    // Neither stylesheet is co-located with the page on screen, so the
    // ambiguity is real — exactly the case Z8 keeps as a choice.
    setOpenPageFile('src/screens/Billing.jsx')
  })

  it('renders one remedy per candidate file and nothing on the toast bus', () => {
    const plan = collectStyleRuleEdits({ [RULE_ID]: newRule() })
    const spy = dialogSpy()

    reportStyleRulePlanRefusals(plan, spy.open)

    expect(toasts()).toEqual([])
    expect(spy.opened).toHaveLength(1)
    const { constraint } = spy.opened[0]!
    expect(constraint.reason).toBe('ambiguous-stylesheet')
    expect(constraint.actions.filter((a) => a.kind === 'choose-stylesheet').map((a) => a.stylesheet?.file)).toEqual([
      'src/styles/base.css',
      'src/styles/marketing.css',
    ])
    expect(spy.opened[0]!.title).toContain('stylesheet')
  })

  it('opens once per refusal, not once per autosave tick', () => {
    // The rule's baseline is held back on purpose (nothing reached disk), so
    // the SAME refusal recurs on every save until it is answered. An
    // un-deduped dialog would reopen itself over the top of the user
    // answering it.
    const spy = dialogSpy()
    reportStyleRulePlanRefusals(collectStyleRuleEdits({ [RULE_ID]: newRule() }), spy.open)
    reportStyleRulePlanRefusals(collectStyleRuleEdits({ [RULE_ID]: newRule() }), spy.open)

    expect(spy.opened).toHaveLength(1)
  })

  it('answering it makes the very same declarations land in the file the user named', () => {
    const spy = dialogSpy()
    reportStyleRulePlanRefusals(collectStyleRuleEdits({ [RULE_ID]: newRule() }), spy.open)

    const chosen = spy.opened[0]!.constraint.actions.find((action) => action.kind === 'choose-stylesheet')!
    const run = resolveConstraintAction(chosen)
    expect(run).not.toBeNull()
    run!()

    const plan = collectStyleRuleEdits({ [RULE_ID]: newRule() })
    expect(plan.destinationRefusals).toEqual([])
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      op: 'insert',
      file: 'src/styles/base.css',
      selector: '.promo-banner',
      declarations: { color: 'tomato' },
    })
  })
})

describe('a terminal destination refusal keeps its toast', () => {
  it('toasts when there is no candidate to choose between, and opens no dialog', () => {
    // Zero stylesheets, no class page, no page on screen: nothing to ask.
    const plan = collectStyleRuleEdits({ [RULE_ID]: newRule() })
    const spy = dialogSpy()

    reportStyleRulePlanRefusals(plan, spy.open)

    expect(spy.opened).toEqual([])
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.body).toContain('could not find a hand-editable .css file')
  })
})

describe('the plan still advances the baseline for every rule it did not refuse', () => {
  it('counts a destination refusal as something that happened', () => {
    setStudioStyleRuleSources(TWO_STYLESHEETS, {})
    setOpenPageFile('src/screens/Billing.jsx')
    const plan = collectStyleRuleEdits({ [RULE_ID]: newRule() })

    expect(plan.edits).toEqual([])
    expect(styleRulePlanTouchedSomething(plan)).toBe(true)
  })
})

describe('explainCssRuleConstraint — the engine half', () => {
  it('offers no choice without candidates, so a preview surface is unchanged', () => {
    const constraint = explainCssRuleConstraint('ambiguous-stylesheet', 'Two candidates.')
    expect(constraint.actions.map((action) => action.kind)).toEqual(['style-inline-instead'])
  })

  it('never offers a choice for a reason that has none', () => {
    const constraint = explainCssRuleConstraint('no-editable-stylesheet', 'Nothing to write into.', {
      ruleId: RULE_ID,
      candidates: ['src/styles/base.css'],
    })
    expect(constraint.actions.map((action) => action.kind)).toEqual(['style-inline-instead'])
  })
})
