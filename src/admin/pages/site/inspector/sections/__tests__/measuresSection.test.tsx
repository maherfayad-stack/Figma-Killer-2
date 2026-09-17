/**
 * MeasuresSection — Penpot's Measures section (`STATE.md` `panel-25`, P3
 * item 3).
 *
 * Covers:
 *   1. Rotation — ported from `positionSection.test.tsx`'s own "3. Rotation"
 *      describe block, onto `MeasuresSection`'s store-backed write path
 *      (`commitApi` instead of the old `onChange` prop).
 *   2. Z-index settings affordance — ported from `positionSection.test.tsx`'s
 *      own "2. Z-index settings affordance" block. Now lives on the
 *      position/constraints row rather than paired with rotation (see
 *      `MeasuresSection.tsx`'s own "Where z-index lives" doc) but stays
 *      resident regardless of the Constraints-vs-Flex-element face.
 *   3. The absolute-mode constraint side-picker — ported from
 *      `positionSection.test.tsx`'s own "1. Constraint side-picker" block.
 *   4. The Constraints-vs-Flex-element identity swap — NEW coverage (the old
 *      `PositionSection.tsx` never had a parent-layout-driven identity swap
 *      at all): a "Flex element" header appears only once a live mocked
 *      canvas frame proves the parent is a flex/grid container, matching
 *      `AlignSection.test.tsx`'s own mocked-frame technique.
 *   5. The radius cluster — ported from `appearanceSection.test.tsx`'s own
 *      "1 + 2. Radius cluster" describe block, mounting `RadiusCluster`
 *      directly (its props contract is unchanged from the old
 *      `AppearanceSection`).
 *   6. Code-locked properties — new coverage, the same per-field (never
 *      per-row) posture `LayerSection`/`AlignSection` already established.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { registerFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { MeasuresSection } from '../MeasuresSection'
import { RadiusCluster } from '../RadiusCluster'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

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
  } as Parameters<typeof useEditorStore.setState>[0])
})

function selectNode(overrides: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div', ...overrides }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function currentNode() {
  return useEditorStore.getState().site?.pages[0]?.nodes[NODE_ID]
}

// ---------------------------------------------------------------------------
// 1. Rotation
// ---------------------------------------------------------------------------

describe('MeasuresSection — rotation field', () => {
  it('renders a resident rotation field with a 0deg placeholder when unset', () => {
    selectNode()
    render(<MeasuresSection />)
    const field = screen.getByRole('textbox', { name: 'Rotation' })
    expect(field.getAttribute('placeholder')).toBe('0deg')
  })

  it('commits a typed rotation value on blur, writing the standalone `rotate` property', () => {
    selectNode()
    render(<MeasuresSection />)

    const field = screen.getByRole('textbox', { name: 'Rotation' })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '45deg' } })
    fireEvent.blur(field)

    expect(currentNode()?.inlineStyles?.rotate).toBe('45deg')
  })

  it('shows a clear button once rotation is set, and clears the `rotate` property', () => {
    selectNode({ inlineStyles: { rotate: '45deg' } })
    render(<MeasuresSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear rotation' }))
    expect(currentNode()?.inlineStyles?.rotate).toBeUndefined()
  })

  it('falls back to the raw `transform` row instead of the rotate field when transform already has a rotate function', () => {
    selectNode({ inlineStyles: { transform: 'rotate(30deg) translateX(10px)' } })
    render(<MeasuresSection />)

    expect(screen.queryByRole('textbox', { name: 'Rotation' })).toBeNull()
    expect(screen.getByTestId('css-property-row-transform')).toBeTruthy()
    expect(screen.getByText(/already set inside/i)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2. Z-index settings affordance — resident on the position row
// ---------------------------------------------------------------------------

describe('MeasuresSection — z-index settings affordance', () => {
  it('keeps the z-index row collapsed behind the settings trigger until opened', () => {
    selectNode({ inlineStyles: { zIndex: 5 } })
    render(<MeasuresSection />)

    expect(screen.queryByTestId('css-property-row-zIndex')).toBeNull()
    expect(screen.getByText('z 5')).toBeTruthy()

    fireEvent.click(screen.getByTestId('position-settings-trigger'))
    expect(screen.getByTestId('css-property-row-zIndex')).toBeTruthy()
  })

  it('shows no badge when z-index is unset', () => {
    selectNode()
    render(<MeasuresSection />)
    expect(screen.queryByText(/^z /)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Absolute-mode constraints — the per-axis constraint dropdown (F29/G10.3)
// ---------------------------------------------------------------------------

describe('MeasuresSection — absolute-mode constraints', () => {
  it('shows the constraint dropdowns only in absolute/fixed position, not relative', () => {
    selectNode({ inlineStyles: { position: 'relative' } })
    render(<MeasuresSection />)
    expect(screen.queryByLabelText('X constraint')).toBeNull()
    expect(screen.getByTestId('css-direction-input-left')).toBeTruthy()
  })

  it('offers all five of Figma constraints per axis, reading back the one the bag declares', () => {
    selectNode({ inlineStyles: { position: 'absolute', left: '10px' } })
    render(<MeasuresSection />)

    // The trigger is a readonly input carrying the selected option's TEXT.
    const combobox = screen.getByRole('combobox', { name: 'X constraint' }) as HTMLInputElement
    expect(combobox.value).toBe('Left')
    // Scoped to the X cell — the Y axis offers "Centre"/"Scale" under the
    // same names.
    const xAxis = within(screen.getByTestId('css-constraint-left-right'))
    for (const name of ['Left', 'Right', 'Left and right', 'Centre', 'Scale']) {
      expect(xAxis.getByRole('option', { name, hidden: true })).toBeTruthy()
    }
  })

  it('refuses the whole cluster, by name, when no frame can confirm the containing block', () => {
    selectNode({ inlineStyles: { position: 'absolute', left: '10px' } })
    render(<MeasuresSection />)

    // The dropdown is a claim about the element's relationship to its parent;
    // with nothing rendering that parent it is disabled with the reason
    // rather than quietly writing an inset that anchors somewhere else.
    const combobox = screen.getByLabelText('X constraint') as HTMLSelectElement
    expect(combobox.disabled).toBe(true)
    expect(screen.getByTestId('css-constraints-diagram').getAttribute('data-disabled')).toBe('true')

    // The inset itself is still an ordinary declaration and stays editable.
    expect(screen.getByTestId('css-constraint-input-left-right')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3b. A constraint change, against a measured containing block
// ---------------------------------------------------------------------------

describe('MeasuresSection — constraint writes', () => {
  let frameAdapters: PortalFrameAdapter[] = []

  afterEach(() => {
    document.body.innerHTML = ''
    for (const adapter of frameAdapters) adapter.dispose()
    frameAdapters = []
  })

  /** One frame carrying the node AND its parent, so the gate and the geometry both resolve. */
  function mountPositionedPair(nodeStyle: Partial<CSSStyleDeclaration>) {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument!
    frameDoc.body.setAttribute('data-breakpoint-id', 'desktop')
    const parent = frameDoc.createElement('div')
    parent.setAttribute('data-node-id', ROOT_ID)
    Object.assign(parent.style, { position: 'relative', width: '200px', height: '100px' })
    const el = frameDoc.createElement('div')
    el.setAttribute('data-node-id', NODE_ID)
    Object.assign(el.style, nodeStyle)
    parent.appendChild(el)
    frameDoc.body.appendChild(parent)
    const adapter = new PortalFrameAdapter(frameDoc)
    frameAdapters.push(adapter)
    registerFrameAdapter(frame, adapter)
  }

  function pickConstraint(axisLabel: string, option: string) {
    const combobox = screen.getByRole('combobox', { name: axisLabel })
    fireEvent.click(combobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: option }))
  }

  it('the stretch constraint writes both insets and clears the size in ONE history entry', () => {
    selectNode({ inlineStyles: { position: 'absolute', left: '10px', width: '50px' } })
    mountPositionedPair({ position: 'absolute', left: '10px', right: '20px', width: '50px' })
    render(<MeasuresSection />)

    const before = useEditorStore.getState()._historyPast.length
    pickConstraint('X constraint', 'Left and right')

    // Both insets land, the size that would fight them is cleared. The exact
    // `right` value comes from whatever the frame measures (happy-dom does
    // not lay out, so it is the mapping's `0px` fallback here, not `20px`) —
    // the fact under test is that the axis ends up defined by TWO edges.
    const styles = currentNode()?.inlineStyles
    expect(styles?.left).toBe('10px')
    expect(styles?.right).toBeDefined()
    expect(styles?.width).toBeUndefined()
    expect(useEditorStore.getState()._historyPast.length).toBe(before + 1)
  })

  it('a stretched axis shows an editable field for BOTH of its insets', () => {
    selectNode({ inlineStyles: { position: 'absolute', left: '10px', right: '20px' } })
    mountPositionedPair({ position: 'absolute', left: '10px', right: '20px' })
    render(<MeasuresSection />)

    expect(screen.getByTestId('css-constraint-input-left-right')).toBeTruthy()
    expect(screen.getByTestId('css-constraint-input-right')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 4. Constraints-vs-Flex-element identity swap (NEW coverage)
// ---------------------------------------------------------------------------

describe('MeasuresSection — Constraints-vs-Flex-element identity swap', () => {
  let frameAdapters: PortalFrameAdapter[] = []

  afterEach(() => {
    document.body.innerHTML = ''
    for (const adapter of frameAdapters) adapter.dispose()
    frameAdapters = []
  })

  function mountCanvasNode(nodeId: string, style: Partial<CSSStyleDeclaration>) {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument!
    frameDoc.body.setAttribute('data-breakpoint-id', 'desktop')
    const el = frameDoc.createElement('div')
    el.setAttribute('data-node-id', nodeId)
    Object.assign(el.style, style)
    frameDoc.body.appendChild(el)
    const adapter = new PortalFrameAdapter(frameDoc)
    frameAdapters.push(adapter)
    registerFrameAdapter(frame, adapter)
  }

  it('shows no "Flex element" header for a node with no live parent frame', () => {
    selectNode()
    render(<MeasuresSection />)
    expect(screen.queryByText('Flex element')).toBeNull()
    // The position/constraints row still renders, unlabeled.
    expect(screen.getByTestId('position-settings-trigger')).toBeTruthy()
  })

  it('shows the "Flex element" header once the parent is confirmed flex/grid', () => {
    selectNode()
    mountCanvasNode(ROOT_ID, { display: 'flex', flexDirection: 'row' })
    render(<MeasuresSection />)

    expect(screen.getByText('Flex element')).toBeTruthy()
    // Same content, now inside the labeled face — z-index stays reachable.
    expect(screen.getByTestId('position-settings-trigger')).toBeTruthy()
  })

  it('shows no "Flex element" header when the parent is a plain block container', () => {
    selectNode()
    mountCanvasNode(ROOT_ID, { display: 'block' })
    render(<MeasuresSection />)
    expect(screen.queryByText('Flex element')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. Radius cluster — ported from `appearanceSection.test.tsx`
// ---------------------------------------------------------------------------

function noop() {}

type RadiusProps = ComponentProps<typeof RadiusCluster>

function renderRadius(overrides: Partial<RadiusProps> = {}) {
  return render(<RadiusCluster storedStyles={{}} currentStyles={{}} onChange={noop} {...overrides} />)
}

function radiusInput(id: string): HTMLInputElement {
  return screen.getByTestId(`measures-radius-${id}-field`) as HTMLInputElement
}

function editRadius(id: string, value: string) {
  const input = radiusInput(id)
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input, { target: { value } })
}

function setRadiusExpanded(expected: boolean) {
  const toggle = screen.getByTestId('expandable-field-cluster-radius-toggle')
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true'
  if (isExpanded !== expected) fireEvent.click(toggle)
}

describe('MeasuresSection — radius cluster (RadiusCluster)', () => {
  it('renders a single collapsed radius field when all four corners are equal', () => {
    renderRadius({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
    })
    setRadiusExpanded(false)

    expect(radiusInput('all').value).toBe('4px')
    expect(screen.queryByTestId('measures-radius-TopLeft')).toBeNull()
  })

  it('expands to four independent corner fields, and toggling never calls onChange', () => {
    const onChange = mock(() => {})
    renderRadius({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '8px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
      onChange,
    })

    setRadiusExpanded(true)
    expect(radiusInput('TopLeft').value).toBe('4px')
    expect(radiusInput('TopRight').value).toBe('8px')

    setRadiusExpanded(false)
    setRadiusExpanded(true)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('linked (uniform corners): editing the collapsed field writes all four corner keys', () => {
    const calls: Array<[string, unknown]> = []
    renderRadius({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
      onChange: (p, v) => calls.push([String(p), v]),
    })
    setRadiusExpanded(false)

    editRadius('all', '10px')

    expect(calls).toContainEqual(['borderTopLeftRadius', '10px'])
    expect(calls).toContainEqual(['borderTopRightRadius', '10px'])
    expect(calls).toContainEqual(['borderBottomRightRadius', '10px'])
    expect(calls).toContainEqual(['borderBottomLeftRadius', '10px'])
    expect(calls).toHaveLength(4)
  })

  it('unlinked (mixed corners): editing one expanded corner writes only that key', () => {
    const calls: Array<[string, unknown]> = []
    renderRadius({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '8px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
      onChange: (p, v) => calls.push([String(p), v]),
    })
    setRadiusExpanded(true)

    editRadius('TopRight', '12px')

    expect(calls).toEqual([['borderTopRightRadius', '12px']])
  })
})

// ---------------------------------------------------------------------------
// 6. Code-locked properties — the field disables, never the whole row
// ---------------------------------------------------------------------------

describe('MeasuresSection — code-locked properties', () => {
  it('refuses a rotate write when rotate is code-valued, without touching the rest of the row', () => {
    selectNode({ codeProps: ['style:rotate'] })
    render(<MeasuresSection />)

    const field = screen.getByRole('textbox', { name: 'Rotation' })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '45deg' } })
    fireEvent.blur(field)

    expect(currentNode()?.inlineStyles?.rotate).toBeUndefined()
  })
})
