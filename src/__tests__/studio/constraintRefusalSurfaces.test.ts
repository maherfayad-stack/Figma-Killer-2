/**
 * The refusal TRANSPORT: an `EditConstraint` reaching a user with its reason,
 * its way forward, and its source origin intact.
 *
 * The engine half (`editConstraint.ts`) has its own exhaustive suite. What is
 * covered here is everything between it and the screen — the kind → handler
 * table, the toast/dialog shape a refused structural gesture produces, and the
 * plan objects that carry the constraint out of the store. Those are the parts
 * that used to drop `actions` and `origin` on the floor.
 *
 * `store-10` (R2) split the old single toast path
 * (`presentStructuralRefusal`, née `toastStructuralRefusal`) in two: a
 * constraint with an empty `actions` array still toasts, byte-for-byte;
 * anything else opens `structuralRefusalDialog` in `uiSlice` instead — see
 * that function's own doc for exactly why the split is keyed on the array,
 * not on which of THIS caller's actions happen to be resolvable.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  __resetToastBusForTests,
  subscribeToasts,
  type Toast,
} from '@ui/components/Toast/toastBus'
import type { EditConstraint } from '@core/page-tree'
import {
  constraintOriginLabel,
  constraintToastBody,
  resolveConstraintAction,
} from '@site/store/constraintActions'
import {
  STRUCTURAL_REFUSAL_TITLE,
  presentStructuralRefusal,
} from '@site/store/slices/site/structuralSourceEdits'
import type { EditorStoreSetter } from '@site/store/slices/site/types'
import type { StructuralRefusalDialogState } from '@site/store/slices/structuralRefusalDialogState'

afterEach(() => {
  __resetToastBusForTests()
})

function toasts(): ReadonlyArray<Toast> {
  let captured: ReadonlyArray<Toast> = []
  const unsubscribe = subscribeToasts((next) => {
    captured = next
  })
  unsubscribe()
  return captured
}

/**
 * A minimal stand-in for the store's own `set` — just enough to capture
 * whatever `presentStructuralRefusal` writes to `structuralRefusalDialog`,
 * without pulling in the whole composed `EditorStore`.
 */
function fakeDialogSetter(): { set: EditorStoreSetter; dialog: () => StructuralRefusalDialogState | null } {
  let value: StructuralRefusalDialogState | null = null
  const draft = {
    get structuralRefusalDialog() {
      return value
    },
    set structuralRefusalDialog(next: StructuralRefusalDialogState | null) {
      value = next
    },
  }
  const set = ((recipe) => recipe(draft as never)) as EditorStoreSetter
  return { set, dialog: () => value }
}

const LIST_ROW: EditConstraint = {
  reason: 'list-row',
  scope: 'node',
  explanation: 'One piece of source renders every row of this list.',
  origin: { rel: 'src/pages/Home.tsx', line: 70, col: 21 },
  actions: [
    { label: 'Open the array in code', kind: 'edit-array', target: { rel: 'src/pages/Home.tsx', line: 70, col: 21 } },
  ],
}

const MULTI_SELECT: EditConstraint = {
  reason: 'multi-select',
  scope: 'node',
  explanation: 'Studio can only write one moved element at a time.',
  actions: [{ label: 'Drag them one by one', kind: 'select-container' }],
}

const TERMINAL: EditConstraint = {
  reason: 'route-chrome',
  scope: 'node',
  explanation: 'This element is part of the route shell, not this page.',
  actions: [],
}

/** A caller that CAN open a file — the component surfaces pass `jumpToSource`. */
const CAN_OPEN = { openSource: () => {} }

describe('resolveConstraintAction', () => {
  it('runs an action that names a file', () => {
    expect(resolveConstraintAction(LIST_ROW.actions[0]!, CAN_OPEN)).toBeInstanceOf(Function)
  })

  it('leaves a file-opening action un-runnable for a caller that cannot open one', () => {
    expect(resolveConstraintAction(LIST_ROW.actions[0]!)).toBeNull()
  })

  it('leaves an action the editor cannot perform un-runnable, so it renders as advice', () => {
    expect(resolveConstraintAction(MULTI_SELECT.actions[0]!)).toBeNull()
  })

  it('will not detach without the node the refusal is about', () => {
    expect(resolveConstraintAction({ label: 'Detach', kind: 'detach' })).toBeNull()
    expect(resolveConstraintAction({ label: 'Detach', kind: 'detach' }, { nodeId: 'a.tsx:1:1' })).toBeInstanceOf(Function)
  })
})

describe('constraintOriginLabel', () => {
  it('names the file and line, not the whole path', () => {
    expect(constraintOriginLabel({ rel: 'src/pages/Home.tsx', line: 70, col: 21 })).toBe('Home.tsx:70')
  })
})

describe('constraintToastBody', () => {
  it('appends a way forward the editor cannot run, since a button cannot say it', () => {
    expect(constraintToastBody(MULTI_SELECT)).toBe(
      'Studio can only write one moved element at a time. Drag them one by one.',
    )
  })

  it('leaves a runnable action out of the sentence — it becomes the toast button', () => {
    expect(constraintToastBody(LIST_ROW, CAN_OPEN)).toBe(LIST_ROW.explanation)
  })

  it('says only the engine sentence when there is no way forward', () => {
    expect(constraintToastBody(TERMINAL)).toBe(TERMINAL.explanation)
  })
})

describe('presentStructuralRefusal — toast path (constraint.actions is empty)', () => {
  /** Stands in for the store's own `get` — the state a jump-to-source needs. */
  const getState = () => ({
    site: { files: [{ id: 'file-home', path: 'src/pages/Home.tsx' }] },
    openInEditor: () => {},
  })

  it('offers the source origin when there is no action to name a file', () => {
    const { set } = fakeDialogSetter()
    presentStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.delete,
      { ...TERMINAL, origin: { rel: 'src/pages/Home.tsx', line: 12, col: 4 } },
      { getState, set },
    )

    expect(toasts()[0]?.action?.label).toBe('Open Home.tsx:12')
  })

  it('does not expire, and offers no action for a refusal that genuinely has no way forward', () => {
    const { set } = fakeDialogSetter()
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.wrap, TERMINAL, { getState, set })

    const [toast] = toasts()
    expect(toast?.durationMs).toBeNull()
    expect(toast?.kind).toBe('warning')
    expect(toast?.body).toBe(TERMINAL.explanation)
    expect(toast?.action).toBeUndefined()
  })

  it('collapses a repeated identical refusal instead of stacking it', () => {
    const { set } = fakeDialogSetter()
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, TERMINAL, { set })
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, TERMINAL, { set })
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, TERMINAL, { set })

    const all = toasts()
    expect(all).toHaveLength(1)
    expect(all[0]?.repeatCount).toBe(3)
  })

  it('keeps two different refusals apart', () => {
    const { set } = fakeDialogSetter()
    const otherTerminal: EditConstraint = { ...TERMINAL, reason: 'reparent', explanation: 'A different refusal.' }
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, TERMINAL, { set })
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, otherTerminal, { set })

    expect(toasts()).toHaveLength(2)
  })

  it('never opens the dialog for an empty-actions constraint', () => {
    const { set, dialog } = fakeDialogSetter()
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.wrap, TERMINAL, { getState, set })

    expect(dialog()).toBeNull()
  })
})

describe('presentStructuralRefusal — dialog path (constraint.actions is non-empty)', () => {
  it('opens structuralRefusalDialog instead of toasting, for a constraint with a remedy', () => {
    const { set, dialog } = fakeDialogSetter()
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, LIST_ROW, { nodeId: 'src/pages/Home.tsx:70:21', set })

    expect(toasts()).toHaveLength(0)
    expect(dialog()).toEqual({
      title: STRUCTURAL_REFUSAL_TITLE.move,
      constraint: LIST_ROW,
      nodeId: 'src/pages/Home.tsx:70:21',
    })
  })

  it('carries a retry closure through to the dialog state untouched', () => {
    const { set, dialog } = fakeDialogSetter()
    const retry = (_newNodeId: string) => {}
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, LIST_ROW, { nodeId: 'a.tsx:1:1', retry, set })

    expect(dialog()?.retry).toBe(retry)
  })

  it('opens the dialog for shared-component, R2s own motivating case', () => {
    const SHARED_COMPONENT: EditConstraint = {
      reason: 'shared-component',
      scope: 'node',
      explanation: 'This element comes from a shared component.',
      actions: [
        { label: 'Detach this instance', kind: 'detach' },
        { label: 'Duplicate as a new file and edit that', kind: 'extract' },
      ],
    }
    const { set, dialog } = fakeDialogSetter()
    presentStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, SHARED_COMPONENT, { nodeId: 'a.tsx:1:1', set })

    expect(toasts()).toHaveLength(0)
    expect(dialog()?.constraint).toBe(SHARED_COMPONENT)
  })
})
