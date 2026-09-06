/**
 * The refusal TRANSPORT: an `EditConstraint` reaching a user with its reason,
 * its way forward, and its source origin intact.
 *
 * The engine half (`editConstraint.ts`) has its own exhaustive suite. What is
 * covered here is everything between it and the screen — the kind → handler
 * table, the toast shape a refused structural gesture produces, and the plan
 * objects that carry the constraint out of the store. Those are the parts that
 * used to drop `actions` and `origin` on the floor.
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
  toastStructuralRefusal,
} from '@site/store/slices/site/structuralSourceEdits'

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

describe('toastStructuralRefusal', () => {
  /** Stands in for the store's own `get` — the state a jump-to-source needs. */
  const getState = () => ({
    site: { files: [{ id: 'file-home', path: 'src/pages/Home.tsx' }] },
    openInEditor: () => {},
  })

  it('does not expire, and carries the constraint way forward as its action', () => {
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, LIST_ROW, getState)

    const [toast] = toasts()
    expect(toast?.durationMs).toBeNull()
    expect(toast?.kind).toBe('warning')
    expect(toast?.body).toBe(LIST_ROW.explanation)
    expect(toast?.action?.label).toBe('Open the array in code')
  })

  it('offers the source origin when no action names a file', () => {
    toastStructuralRefusal(
      STRUCTURAL_REFUSAL_TITLE.delete,
      { ...MULTI_SELECT, origin: { rel: 'src/pages/Home.tsx', line: 12, col: 4 } },
      getState,
    )

    expect(toasts()[0]?.action?.label).toBe('Open Home.tsx:12')
  })

  it('offers no action for a refusal that genuinely has no way forward', () => {
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.wrap, TERMINAL, getState)

    expect(toasts()[0]?.action).toBeUndefined()
  })

  it('collapses a repeated identical refusal instead of stacking it', () => {
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, LIST_ROW)
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, LIST_ROW)
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, LIST_ROW)

    const all = toasts()
    expect(all).toHaveLength(1)
    expect(all[0]?.repeatCount).toBe(3)
  })

  it('keeps two different refusals apart', () => {
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.move, LIST_ROW)
    toastStructuralRefusal(STRUCTURAL_REFUSAL_TITLE.delete, TERMINAL)

    expect(toasts()).toHaveLength(2)
  })
})
