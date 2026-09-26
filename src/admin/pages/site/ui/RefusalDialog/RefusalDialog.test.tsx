/**
 * RefusalDialog — R2 (`store-10`). Covers the one behavior this component
 * adds beyond rendering `ConstraintActionButtons` in a `<Dialog>`: the
 * detach/extract retry-after-reload mechanism.
 *
 * The store's `detachInstances` (P5-C's one Detach action) is replaced with a
 * spy and `extractInstanceCopy` is mocked, so this never touches the
 * network or a real `.tsx` file — `constraintRefusalSurfaces.test.ts` already
 * covers `presentStructuralRefusal`'s toast-vs-dialog split at the store
 * layer; this suite is the one level up, the actual rendered dialog.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EditConstraint } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { DetachInstancesOutcome } from '@site/store/slices/site/instanceDetachTypes'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'

let detachOutcome: DetachInstancesOutcome = 'detached'
const detachInstances = mock((_nodeIds: readonly string[]) => Promise.resolve(detachOutcome))
const realDetachInstances = useEditorStore.getState().detachInstances
const extractInstanceCopy = mock(() => Promise.resolve({ ok: true as const }))

// `mock.module` is process-wide and PERMANENT — `mock.restore()` does not undo
// it, and `bun test --parallel=4` gives each worker a process, not a file. The
// replacement below publishes one of `studioSaveRequests`'s exports; every
// later file in the worker that imports any other one would get `undefined`.
// Snapshot the real namespace as a plain object BEFORE mocking (the namespace
// object itself is live and gets rewritten). Gated by
// `mock-module-must-restore.test.ts`.
const realStudioSaveRequests = { ...(await import('@site/studio/studioSaveRequests')) }

mock.module('@site/studio/studioSaveRequests', () => ({
  ...realStudioSaveRequests,
  extractInstanceCopy,
}))

afterAll(() => {
  mock.module('@site/studio/studioSaveRequests', () => realStudioSaveRequests)
})

const { RefusalDialog } = await import('./RefusalDialog')

afterEach(() => {
  cleanup()
  detachInstances.mockClear()
  extractInstanceCopy.mockClear()
  useEditorStore.setState({ detachInstances: realDetachInstances })
})

const CALL_SITE = 'src/pages/Home.tsx:5:1'
const ORIGINAL_NODE_ID = `${CALL_SITE}~src/components/Header.tsx:8:1`

const SHARED_COMPONENT: EditConstraint = {
  reason: 'shared-component',
  scope: 'node',
  explanation: 'This element comes from a shared component.',
  origin: { rel: 'src/components/Header.tsx', line: 8, col: 1 },
  actions: [
    { label: 'Detach this instance', kind: 'detach' },
    { label: 'Duplicate as a new file and edit that', kind: 'extract' },
  ],
}

function siteWithNode(nodeId: string) {
  const node = makeNode({ id: nodeId, moduleId: 'base.div' })
  const page = makePage({ nodes: { root: makeNode({ id: 'root', children: [nodeId] }), [nodeId]: node } })
  return makeSite({ pages: [page] })
}

beforeEach(() => {
  detachOutcome = 'detached'
  useEditorStore.setState({
    site: siteWithNode(ORIGINAL_NODE_ID),
    structuralRefusalDialog: null,
    detachInstances,
  })
})

describe('RefusalDialog', () => {
  it('runs Detach and closes once it lands — it no longer re-issues the gesture (P3-D)', async () => {
    act(() => {
      useEditorStore.setState({
        structuralRefusalDialog: { title: 'Delete refused', constraint: SHARED_COMPONENT, nodeId: ORIGINAL_NODE_ID },
      })
    })
    render(<RefusalDialog />)
    fireEvent.click(screen.getByRole('button', { name: /detach this instance/i }))
    await waitFor(() => expect(detachInstances).toHaveBeenCalledWith([ORIGINAL_NODE_ID]))
    await waitFor(() => expect(useEditorStore.getState().structuralRefusalDialog).toBeNull())
  })

  it('stays open when the detach is refused or cancelled, so the other remedy is still there (P5-C)', async () => {
    detachOutcome = 'refused'
    act(() => {
      useEditorStore.setState({
        structuralRefusalDialog: { title: 'Delete refused', constraint: SHARED_COMPONENT, nodeId: ORIGINAL_NODE_ID },
      })
    })
    render(<RefusalDialog />)
    fireEvent.click(screen.getByRole('button', { name: /detach this instance/i }))
    await waitFor(() => expect(detachInstances).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(useEditorStore.getState().structuralRefusalDialog).not.toBeNull()
  })

  it('dismisses immediately for a non-detach/extract action — nothing to retry', () => {
    const jumpToSourceOnlyConstraint: EditConstraint = {
      reason: 'list-row',
      scope: 'node',
      explanation: 'One piece of source renders every row of this list.',
      actions: [
        { label: 'Open the array in code', kind: 'edit-array', target: { rel: 'src/pages/Home.tsx', line: 70, col: 21 } },
      ],
    }
    act(() => {
      useEditorStore.setState({
        structuralRefusalDialog: {
          title: 'Delete refused',
          constraint: jumpToSourceOnlyConstraint,
          nodeId: ORIGINAL_NODE_ID,
        },
      })
    })

    render(<RefusalDialog />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /open the array in code/i }))

    expect(useEditorStore.getState().structuralRefusalDialog).toBeNull()
  })
})
