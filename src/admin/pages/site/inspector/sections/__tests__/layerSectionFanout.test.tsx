/**
 * LayerSection — `node.hidden` / `node.locked` over a MULTI-selection
 * (`panel-40`, closing the landmine `panel-38` recorded).
 *
 * Before this, both buttons read and toggled the ANCHOR: the user selected
 * five layers, clicked the eye, and one of them disappeared.
 *
 * Covers:
 *   1. The eye hides EVERY selected layer, in one history entry.
 *   2. A selection that disagrees reads Mixed in the button's label, renders
 *      unpressed, and the first click agrees it (Figma's contract — the same
 *      call §9.3 already makes for the CSS-visibility toggle).
 *   3. The same three facts for the lock.
 *   4. A single selection is unchanged — the anchor path still works when
 *      `selectedNodeIds` has one entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { LayerSection } from '../LayerSection'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const ROOT_ID = 'root'
const IDS = ['node-a', 'node-b', 'node-c']

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    activeDocument: null,
    _historyPast: [],
    _historyFuture: [],
  } as Parameters<typeof useEditorStore.setState>[0])
})

/** Seed three sibling nodes and select all of them, anchor last. */
function selectThree(perNode: Array<Partial<Parameters<typeof makeNode>[0]>> = []) {
  const nodes: Record<string, ReturnType<typeof makeNode>> = {
    [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [...IDS] }),
  }
  IDS.forEach((id, i) => {
    nodes[id] = makeNode({ id, moduleId: 'base.div', ...(perNode[i] ?? {}) })
  })
  const page = makePage({ id: 'page-1', rootNodeId: ROOT_ID, nodes })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: IDS[IDS.length - 1],
    selectedNodeIds: [...IDS],
  } as Parameters<typeof useEditorStore.setState>[0])
}

function nodeOf(id: string) {
  return useEditorStore.getState().site!.pages[0].nodes[id]
}

function historyLength(): number {
  return useEditorStore.getState()._historyPast.length
}

describe('LayerSection — the eye over a multi-selection', () => {
  it('hides every selected layer in ONE history entry', () => {
    selectThree()
    render(<LayerSection />)
    const before = historyLength()

    fireEvent.click(screen.getByTestId('layer-visibility-toggle'))

    for (const id of IDS) expect(nodeOf(id).hidden).toBe(true)
    expect(historyLength()).toBe(before + 1)
  })

  it('reads Mixed when the selection disagrees, and the first click agrees it', () => {
    selectThree([{ hidden: true }])
    render(<LayerSection />)

    const eye = screen.getByTestId('layer-visibility-toggle')
    expect(eye.getAttribute('aria-label')).toContain('Mixed')
    // No indeterminate glyph — the button renders unpressed and says so in
    // words (`docs/features/inspector.md` §9.3).
    expect(eye.getAttribute('aria-pressed')).not.toBe('true')

    fireEvent.click(eye)
    for (const id of IDS) expect(nodeOf(id).hidden).toBe(true)
  })

  it('shows every selected layer again when they all agree on hidden', () => {
    selectThree([{ hidden: true }, { hidden: true }, { hidden: true }])
    render(<LayerSection />)

    const eye = screen.getByTestId('layer-visibility-toggle')
    expect(eye.getAttribute('aria-label')).toBe('Show on canvas')

    fireEvent.click(eye)
    for (const id of IDS) expect(nodeOf(id).hidden).toBe(false)
  })
})

describe('LayerSection — the lock over a multi-selection', () => {
  it('locks every selected layer in ONE history entry', () => {
    selectThree()
    render(<LayerSection />)
    const before = historyLength()

    fireEvent.click(screen.getByTestId('layer-lock-toggle'))

    for (const id of IDS) expect(nodeOf(id).locked).toBe(true)
    expect(historyLength()).toBe(before + 1)
  })

  it('reads Mixed when the selection disagrees, and the first click agrees it', () => {
    selectThree([{ locked: true }, {}, {}])
    render(<LayerSection />)

    const lock = screen.getByTestId('layer-lock-toggle')
    expect(lock.getAttribute('aria-label')).toContain('Mixed')
    expect(lock.getAttribute('aria-pressed')).not.toBe('true')

    fireEvent.click(lock)
    for (const id of IDS) expect(nodeOf(id).locked).toBe(true)
  })
})

describe('LayerSection — a single selection is unchanged', () => {
  it('still hides exactly the one selected layer', () => {
    selectThree()
    useEditorStore.setState({
      selectedNodeId: IDS[0],
      selectedNodeIds: [IDS[0]],
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<LayerSection />)

    fireEvent.click(screen.getByTestId('layer-visibility-toggle'))

    expect(nodeOf(IDS[0]).hidden).toBe(true)
    expect(nodeOf(IDS[1]).hidden).toBeFalsy()
    expect(nodeOf(IDS[2]).hidden).toBeFalsy()
  })
})
