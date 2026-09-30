/**
 * P3-C (WB-30, partial) — a class whose declarations cannot reach disk (a
 * Tailwind utility, a compiled build artefact) is still reported, but the
 * warning now carries the remedy its sentence names: one click switches the
 * panel to the element's own inline-style layer, which does write back — the
 * same target `ClassCssLockedNotice`'s button and the Element chip switch to.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { useEditorStore } from '@site/store/store'
import { reportStyleRulePlanRefusals, resetRefusalToasts } from '@site/studio/refusalToasts'

function latestToasts(): Toast[] {
  let latest: Toast[] = []
  subscribeToasts((snapshot) => {
    latest = [...snapshot]
  })
  return latest
}

beforeEach(() => {
  __resetToastBusForTests()
  resetRefusalToasts()
  useEditorStore.getState().setInlineStyleEditing(false)
})

describe('WB-30 — an unwritable class offers "Style the element instead"', () => {
  it('the warning carries the action, and the action switches to the element target', () => {
    reportStyleRulePlanRefusals({
      edits: [],
      unmapped: [{ label: '.bg-lime-400', reason: null }],
      unwritableContexts: [],
      ruleIdsByNodeId: {},
    } as unknown as Parameters<typeof reportStyleRulePlanRefusals>[0])

    const [toast] = latestToasts()
    expect(toast?.kind).toBe('warning')
    expect(toast?.action?.label).toBe('Style the element instead')

    toast!.action!.onSelect()
    expect(useEditorStore.getState().inlineStyleEditing).toBe(true)
  })
})
