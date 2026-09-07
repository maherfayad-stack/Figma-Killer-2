/**
 * The class-target gate decision for a multi-selection (W8-3 phase 3).
 *
 * What this pins: a bulk class edit is offered, not refused — but never
 * without first saying how many elements OUTSIDE the selection it moves.
 * The count comes from the store's O(1) `_classIdToNodeCount` index, and
 * "the class is only on the selected nodes" is the one case that needs no
 * gate at all, because then the class edit IS the bulk edit.
 */
import { describe, expect, it } from 'bun:test'
import { bulkClassQuestion, resolveBulkClassTarget } from '../multiSelectClassTarget'

const selectorFor = (classId: string) => (classId.startsWith('ambient') ? null : `.${classId}`)

describe('resolveBulkClassTarget', () => {
  it('offers nothing when the nodes share no class', () => {
    const decision = resolveBulkClassTarget(
      [{ classIds: ['card'] }, { classIds: ['badge'] }],
      selectorFor,
      new Map([
        ['card', 1],
        ['badge', 1],
      ]),
    )
    expect(decision.kind).toBe('no-shared-class')
  })

  it('offers nothing for a selection of one', () => {
    const decision = resolveBulkClassTarget([{ classIds: ['card'] }], selectorFor, new Map())
    expect(decision.kind).toBe('no-shared-class')
  })

  it('needs no confirmation when only the selection carries the class', () => {
    const decision = resolveBulkClassTarget(
      [{ classIds: ['card'] }, { classIds: ['card'] }],
      selectorFor,
      new Map([['card', 2]]),
    )
    expect(decision.kind).toBe('allowed')
    if (decision.kind !== 'allowed') return
    expect(decision.target).toEqual({
      classId: 'card',
      selector: '.card',
      usageCount: 2,
      outsideCount: 0,
    })
  })

  it('asks, naming the count, when the class reaches outside the selection', () => {
    const decision = resolveBulkClassTarget(
      [{ classIds: ['card'] }, { classIds: ['card'] }],
      selectorFor,
      new Map([['card', 5]]),
    )
    expect(decision.kind).toBe('needs-confirmation')
    if (decision.kind !== 'needs-confirmation') return
    expect(decision.target.outsideCount).toBe(3)
    expect(decision.question).toBe(
      '.card is used by 3 other elements outside this selection. Editing it changes them too — continue?',
    )
  })

  it('picks the LAST shared class — the one the cascade gives the final word', () => {
    const decision = resolveBulkClassTarget(
      [
        { classIds: ['base', 'card'] },
        { classIds: ['card', 'base'] },
      ],
      selectorFor,
      new Map([
        ['base', 2],
        ['card', 2],
      ]),
    )
    // The anchor is the LAST selected node, whose order is `card`, `base`.
    expect(decision.kind === 'allowed' && decision.target.classId).toBe('base')
  })

  it('never offers an ambient rule — it does not attach by classIds', () => {
    const decision = resolveBulkClassTarget(
      [{ classIds: ['ambient-a'] }, { classIds: ['ambient-a'] }],
      selectorFor,
      new Map([['ambient-a', 9]]),
    )
    expect(decision.kind).toBe('no-shared-class')
  })

  it('clamps a stale index rather than asking about -1 elements', () => {
    const decision = resolveBulkClassTarget(
      [{ classIds: ['card'] }, { classIds: ['card'] }, { classIds: ['card'] }],
      selectorFor,
      new Map([['card', 1]]),
    )
    expect(decision.kind).toBe('allowed')
  })
})

describe('bulkClassQuestion', () => {
  it('speaks of one element in the singular', () => {
    expect(
      bulkClassQuestion({ classId: 'card', selector: '.card', usageCount: 3, outsideCount: 1 }),
    ).toBe(
      '.card is used by 1 other element outside this selection. Editing it changes them too — continue?',
    )
  })
})
