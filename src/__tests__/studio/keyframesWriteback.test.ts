/**
 * W5-5 — the client half of the `@keyframes` write-back diff.
 *
 * The failure this suite exists to prevent is the one
 * `styleRuleWriteback.test.ts` documents at the top of its own file, one field
 * over: a keyframes block is diffed on `rawCss`, not on a declaration bag, so
 * a diff that looked at `styles` (as the class collector does) would compare
 * two empty objects on every save and emit nothing at all — byte-exact codemod
 * tests green, not one keyframe ever reaching a file.
 *
 * The second thing pinned here is that the diff stays PER-DECLARATION. Sending
 * the block text and letting the server write it would be a rewrite: every
 * comment and blank line in a hand-authored `@keyframes` gone on the first
 * duration change.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { collectStyleRuleEdits, setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'

const KEYFRAMES_ID = 'sc-fade'
const NAME = 'fade-in'

const ORIGINAL = `@keyframes ${NAME} {
  from { opacity: 0; }
  to { opacity: 1; }
}`

function keyframesRule(rawCss: string, overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: KEYFRAMES_ID,
    kind: 'ambient',
    name: `@keyframes ${NAME}`,
    selector: `@keyframes ${NAME}`,
    styles: {},
    contextStyles: {},
    rawCss,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

const SOURCES = { [KEYFRAMES_ID]: { file: 'pages/Home.css', selector: `@keyframes ${NAME}` } }

beforeEach(() => {
  setStudioStyleRuleSources(SOURCES, { [KEYFRAMES_ID]: keyframesRule(ORIGINAL) })
})

describe('collectStyleRuleEdits — the @keyframes half', () => {
  it('emits nothing when the block is untouched', () => {
    expect(collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(ORIGINAL) }).edits).toHaveLength(0)
  })

  it('emits ONE per-declaration edit for a changed step, not a block rewrite', () => {
    const edited = ORIGINAL.replace('opacity: 0;', 'opacity: 0.2;')
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(edited) })

    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({
      kind: 'css',
      op: 'keyframe-set',
      file: 'pages/Home.css',
      name: NAME,
      step: 'from',
      property: 'opacity',
      value: '0.2',
    })
  })

  it('a new STEP needs no op of its own — its declarations are ordinary sets', () => {
    const edited = ORIGINAL.replace('to {', '50% { opacity: 0.5; }\n  to {')
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(edited) })

    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({ op: 'keyframe-set', step: '50%', property: 'opacity', value: '0.5' })
  })

  it('a removed DECLARATION becomes an unset — the silent-loss case', () => {
    const edited = `@keyframes ${NAME} {\n  from { opacity: 0; }\n  to { }\n}`
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(edited) })

    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({ op: 'keyframe-unset', step: 'to', property: 'opacity' })
  })

  it('a removed STEP unsets each of its declarations, which drops the step server-side', () => {
    const edited = `@keyframes ${NAME} {\n  from { opacity: 0; }\n}`
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(edited) })

    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0]).toMatchObject({ op: 'keyframe-unset', step: 'to', property: 'opacity' })
  })

  it('maps every emitted edit back to its rule, so a refusal can hold the baseline', () => {
    const edited = ORIGINAL.replace('opacity: 1;', 'opacity: 0.9;')
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(edited) })

    const nodeId = plan.edits[0]!.nodeId
    expect(plan.ruleIdByNodeId[nodeId]).toBe(KEYFRAMES_ID)
  })

  it('reports an IMPORTED block with no source instead of dropping the change', () => {
    setStudioStyleRuleSources({}, { [KEYFRAMES_ID]: keyframesRule(ORIGINAL) })
    const edited = ORIGINAL.replace('opacity: 0;', 'opacity: 0.3;')
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(edited) })

    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped).toEqual([{ label: `@keyframes ${NAME}`, reason: null }])
  })

  it('emits nothing at all for a block whose text stopped parsing — never a guessed write', () => {
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(`@keyframes ${NAME} { from {`) })
    expect(plan.edits).toHaveLength(0)
  })

  it('leaves a `@keyframes` rule out of the CLASS diff — its empty style bag is not a change', () => {
    // The class collector iterates every rule, keyframes included. An
    // unchanged block with no source must produce nothing from EITHER side:
    // not a `set` edit for its empty `{}` declarations bag, and not an
    // `unmapped` report about a change that did not happen.
    setStudioStyleRuleSources({}, { [KEYFRAMES_ID]: keyframesRule(ORIGINAL) })
    const plan = collectStyleRuleEdits({ [KEYFRAMES_ID]: keyframesRule(ORIGINAL) })
    expect(plan.edits).toHaveLength(0)
    expect(plan.unmapped).toHaveLength(0)
  })
})
