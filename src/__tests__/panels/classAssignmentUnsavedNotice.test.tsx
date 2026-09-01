/**
 * Phase 0 item 0.6 — class assignment vanishes with no message.
 *
 * Studio (filesystem) mode has no `class` edit kind: `addNodeClass` /
 * `removeNodeClass` / `reorderNodeClass` only ever mutate `PageNode.classIds`
 * in memory, and `fsCodemodAdapter.saveSite` never used to diff `classIds`,
 * so the change vanished on the next reload with zero explanation.
 *
 * This suite pins the SAVE-TIME version: `notifyClassAssignmentUnsaved`
 * takes a resolved drift list (built by `fsCodemodAdapter.saveSite` from
 * `loadedValuesBaseline.ts`'s `collectClassIdsDrift`) and fires exactly ONE
 * toast naming every affected node/class — replacing the interim per-action
 * toast that used to fire directly from `ClassPicker` on every click.
 */
import { describe, it, expect } from 'bun:test'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { notifyClassAssignmentUnsaved } from '@site/panels/classAssignmentUnsavedNotice'

function collectToasts(): Toast[] {
  let latest: Toast[] = []
  subscribeToasts((snapshot) => {
    latest = [...snapshot]
  })
  return latest
}

describe('notifyClassAssignmentUnsaved', () => {
  it('does nothing for an empty drift list', () => {
    notifyClassAssignmentUnsaved([])
    expect(collectToasts()).toHaveLength(0)
  })

  it('warns, naming the node and the class', () => {
    notifyClassAssignmentUnsaved([
      { nodeLabel: 'Header', addedClassNames: ['card'], removedClassNames: [], reordered: false },
    ])
    const toasts = collectToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe('warning')
    expect(toasts[0].body).toContain('card')
    expect(toasts[0].body).toContain('Header')
    // Track B2 narrowed this notice. Phase 0.6 warned on EVERY class assignment
    // ("can't be written to your source yet") because no `class` edit kind
    // existed; `setJsxClassName` now writes those to disk. What survives is the
    // genuinely-unwritable residue — a `.map` row, a node with no source
    // location — so the message must name that cause, not the old blanket one.
    expect(toasts[0].body).toMatch(/no single place in your source/)
    expect(toasts[0].body).toMatch(/revert the next time this page loads/)
  })

  it('describes a removal and a reorder distinctly from an addition', () => {
    notifyClassAssignmentUnsaved([
      { nodeLabel: 'Header', addedClassNames: [], removedClassNames: ['card'], reordered: false },
    ])
    expect(collectToasts()[0].body).toMatch(/removed card/)
    // The bus only auto-resets BETWEEN tests (the global `afterEach` in
    // `src/__tests__/setup.ts`) — within this one test, the first toast is
    // still in the bus, so `collectToasts()[0]` below would otherwise still
    // be the FIRST (removal) toast rather than the second (reorder) one.
    __resetToastBusForTests()

    notifyClassAssignmentUnsaved([
      { nodeLabel: 'Footer', addedClassNames: [], removedClassNames: [], reordered: true },
    ])
    expect(collectToasts()[0].body).toMatch(/reordered classes/)
  })

  it('names up to 3 nodes and folds the rest into "and N more"', () => {
    notifyClassAssignmentUnsaved([
      { nodeLabel: 'A', addedClassNames: ['x'], removedClassNames: [], reordered: false },
      { nodeLabel: 'B', addedClassNames: ['x'], removedClassNames: [], reordered: false },
      { nodeLabel: 'C', addedClassNames: ['x'], removedClassNames: [], reordered: false },
      { nodeLabel: 'D', addedClassNames: ['x'], removedClassNames: [], reordered: false },
    ])
    const body = collectToasts()[0].body ?? ''
    expect(body).toContain('A (')
    expect(body).toContain('B (')
    expect(body).toContain('C (')
    expect(body).not.toContain('D (')
    expect(body).toMatch(/and 1 more/)
  })
})
