/**
 * PositionSection — G10 (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md).
 *
 * Covers:
 *   1. `resolveAlignWrite` — the pure honesty check behind every align
 *      button: grid parents always resolve to a per-item write, flex
 *      parents resolve to `alignSelf` on the cross axis but only fall
 *      through to the PARENT's `justifyContent` on the main axis when this
 *      node is the parent's only child, and everything else refuses with a
 *      reason instead of guessing.
 *   2. The align row wired to a real (mocked) canvas frame + page tree —
 *      clicking an edge writes the right property to the right target.
 *   3. F29's constraint side-picker — switching Left/Right MOVES the value
 *      (clears the old property, writes the new one) rather than leaving
 *      both set.
 *   4. The z-index settings affordance — collapsed by default (Law 2),
 *      opens on demand.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PositionSection } from '@site/panels/PropertiesPanel/PositionSection'
import { resolveAlignWrite, type ParentLayoutInfo } from '@site/panels/PropertiesPanel/resolveAlignWrite'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'

afterEach(cleanup)

const noop = () => {}

function renderPositionSection(overrides: Partial<React.ComponentProps<typeof PositionSection>> = {}) {
  return render(
    <PositionSection
      currentStyles={{}}
      storedStyles={{}}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      onClearProperty={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1. resolveAlignWrite — pure honesty check
// ---------------------------------------------------------------------------

describe('resolveAlignWrite', () => {
  it('refuses every edge with no parent', () => {
    const result = resolveAlignWrite('left', null)
    expect(result.target).toBe('unavailable')
  })

  it('refuses every edge when the parent is not a flex or grid container', () => {
    const parent: ParentLayoutInfo = { display: 'block', flexDirection: 'row', siblingCount: 1 }
    const result = resolveAlignWrite('center', parent)
    expect(result.target).toBe('unavailable')
  })

  it('grid parent: horizontal edges write justifySelf, vertical edges write alignSelf, regardless of siblings', () => {
    const parent: ParentLayoutInfo = { display: 'grid', flexDirection: 'row', siblingCount: 5 }
    expect(resolveAlignWrite('left', parent)).toEqual({ target: 'self', property: 'justifySelf', value: 'flex-start' })
    expect(resolveAlignWrite('right', parent)).toEqual({ target: 'self', property: 'justifySelf', value: 'flex-end' })
    expect(resolveAlignWrite('top', parent)).toEqual({ target: 'self', property: 'alignSelf', value: 'flex-start' })
    expect(resolveAlignWrite('middle', parent)).toEqual({ target: 'self', property: 'alignSelf', value: 'center' })
  })

  it('flex-row parent: the cross axis (top/middle/bottom) always writes alignSelf on the node', () => {
    const parent: ParentLayoutInfo = { display: 'flex', flexDirection: 'row', siblingCount: 4 }
    expect(resolveAlignWrite('top', parent)).toEqual({ target: 'self', property: 'alignSelf', value: 'flex-start' })
    expect(resolveAlignWrite('bottom', parent)).toEqual({ target: 'self', property: 'alignSelf', value: 'flex-end' })
  })

  it('flex-row parent: the main axis (left/center/right) writes the PARENT justifyContent only when this is the sole child', () => {
    const soleChild: ParentLayoutInfo = { display: 'flex', flexDirection: 'row', siblingCount: 1 }
    expect(resolveAlignWrite('left', soleChild)).toEqual({
      target: 'parent',
      property: 'justifyContent',
      value: 'flex-start',
    })

    const withSiblings: ParentLayoutInfo = { display: 'flex', flexDirection: 'row', siblingCount: 3 }
    const result = resolveAlignWrite('left', withSiblings)
    expect(result.target).toBe('unavailable')
  })

  it('flex-column parent: the axes swap — top/bottom become the main axis', () => {
    const withSiblings: ParentLayoutInfo = { display: 'flex', flexDirection: 'column', siblingCount: 2 }
    expect(resolveAlignWrite('left', withSiblings)).toEqual({
      target: 'self',
      property: 'alignSelf',
      value: 'flex-start',
    })
    expect(resolveAlignWrite('top', withSiblings).target).toBe('unavailable')

    const soleChild: ParentLayoutInfo = { display: 'flex', flexDirection: 'column', siblingCount: 1 }
    expect(resolveAlignWrite('top', soleChild)).toEqual({
      target: 'parent',
      property: 'justifyContent',
      value: 'flex-start',
    })
  })
})

// ---------------------------------------------------------------------------
// 2. The align row against a real (mocked) canvas frame + page tree
// ---------------------------------------------------------------------------

describe('PositionSection — single-node align row', () => {
  const pristine = (() => {
    const { site, activePageId, activeDocument, selectedNodeId, activeBreakpointId } = useEditorStore.getState()
    return { site, activePageId, activeDocument, selectedNodeId, activeBreakpointId }
  })()

  afterEach(() => {
    // Restoring the shared store singleton can still notify a component this
    // very test just rendered (global `cleanup()` — registered before this
    // nested `afterEach` — hasn't unmounted it yet at this point in the
    // teardown order), so wrap in `act` to keep React's update batching
    // honest rather than silencing a real "state changed outside act" case.
    act(() => {
      useEditorStore.setState(pristine)
    })
    document.body.innerHTML = ''
  })

  /** A canvas breakpoint frame with one styled element for a given node id. */
  function mountCanvasNode(nodeId: string, style: Partial<CSSStyleDeclaration>) {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument!
    frameDoc.body.setAttribute('data-breakpoint-id', 'desktop')
    const el = frameDoc.createElement('div')
    el.setAttribute('data-node-id', nodeId)
    Object.assign(el.style, style)
    frameDoc.body.appendChild(el)
    return el
  }

  it('disables every align edge with a reason when no live canvas frame is rendering the parent', () => {
    const child = makeNode({ id: 'child-1', moduleId: 'base.div' })
    const parent = makeNode({ id: 'parent-1', moduleId: 'base.div', children: ['child-1'] })
    const page = makePage({ rootNodeId: 'parent-1', nodes: { 'parent-1': parent, 'child-1': child } })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({ site, activePageId: page.id, activeDocument: null, selectedNodeId: 'child-1', activeBreakpointId: 'desktop' })

    renderPositionSection()

    const leftBtn = screen.getByTestId('align-bar-left')
    expect(leftBtn.getAttribute('aria-disabled')).toBe('true')
  })

  it('flex parent, sole child: clicking "left" writes the PARENT justifyContent as an inline style', async () => {
    const user = userEvent.setup()
    const child = makeNode({ id: 'child-1', moduleId: 'base.div' })
    const parent = makeNode({ id: 'parent-1', moduleId: 'base.div', children: ['child-1'] })
    const page = makePage({ rootNodeId: 'parent-1', nodes: { 'parent-1': parent, 'child-1': child } })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({ site, activePageId: page.id, activeDocument: null, selectedNodeId: 'child-1', activeBreakpointId: 'desktop' })
    mountCanvasNode('parent-1', { display: 'flex', flexDirection: 'row' })

    renderPositionSection()

    const leftBtn = screen.getByTestId('align-bar-left')
    expect(leftBtn.getAttribute('aria-disabled')).not.toBe('true')
    await user.click(leftBtn)

    expect(useEditorStore.getState().site?.pages[0]?.nodes['parent-1']?.inlineStyles).toEqual({
      justifyContent: 'flex-start',
    })
  })

  it('flex parent, sole child: clicking a cross-axis edge writes THIS node\'s own bag via onChange, not the parent', async () => {
    const user = userEvent.setup()
    const child = makeNode({ id: 'child-1', moduleId: 'base.div' })
    const parent = makeNode({ id: 'parent-1', moduleId: 'base.div', children: ['child-1'] })
    const page = makePage({ rootNodeId: 'parent-1', nodes: { 'parent-1': parent, 'child-1': child } })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({ site, activePageId: page.id, activeDocument: null, selectedNodeId: 'child-1', activeBreakpointId: 'desktop' })
    mountCanvasNode('parent-1', { display: 'flex', flexDirection: 'row' })

    let changed: [string, unknown] | null = null
    renderPositionSection({ onChange: (p, v) => { changed = [String(p), v] } })

    await user.click(screen.getByTestId('align-bar-top'))

    expect(changed).toEqual(['alignSelf', 'flex-start'])
    // The parent must be untouched — this was a cross-axis, per-item write.
    expect(useEditorStore.getState().site?.pages[0]?.nodes['parent-1']?.inlineStyles).toBeUndefined()
  })

  it('flex parent WITH siblings: the main-axis edges are disabled with a reason', () => {
    const child = makeNode({ id: 'child-1', moduleId: 'base.div' })
    const sibling = makeNode({ id: 'child-2', moduleId: 'base.div' })
    const parent = makeNode({ id: 'parent-1', moduleId: 'base.div', children: ['child-1', 'child-2'] })
    const page = makePage({
      rootNodeId: 'parent-1',
      nodes: { 'parent-1': parent, 'child-1': child, 'child-2': sibling },
    })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({ site, activePageId: page.id, activeDocument: null, selectedNodeId: 'child-1', activeBreakpointId: 'desktop' })
    mountCanvasNode('parent-1', { display: 'flex', flexDirection: 'row' })

    renderPositionSection()

    expect(screen.getByTestId('align-bar-left').getAttribute('aria-disabled')).toBe('true')
    // Cross axis is still honest even with siblings.
    expect(screen.getByTestId('align-bar-top').getAttribute('aria-disabled')).not.toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 3. Constraint side-picker (F29) — switching sides moves, not duplicates
// ---------------------------------------------------------------------------

describe('PositionSection — absolute-mode constraints', () => {
  it('shows the side pickers only in absolute/fixed position, not relative', () => {
    renderPositionSection({ currentStyles: { position: 'relative' }, storedStyles: { position: 'relative' } })
    expect(screen.queryByLabelText('X anchor side')).toBeNull()
    expect(screen.getByTestId('css-direction-input-left')).toBeTruthy()
  })

  it('switching the horizontal side moves a set value instead of duplicating it', () => {
    const calls: Array<{ fn: string; args: unknown[] }> = []
    renderPositionSection({
      currentStyles: { position: 'absolute', left: '10px' },
      storedStyles: { position: 'absolute', left: '10px' },
      onChange: (...args) => calls.push({ fn: 'onChange', args }),
      onClearProperty: (...args) => calls.push({ fn: 'onClearProperty', args }),
    })

    const combobox = screen.getByRole('combobox', { name: 'X anchor side' })
    fireEvent.click(combobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'Right' }))

    // The value moved: `right` gets it, `left` is cleared. Never both set.
    expect(calls).toContainEqual({ fn: 'onChange', args: ['right', '10px'] })
    expect(calls).toContainEqual({ fn: 'onClearProperty', args: ['left'] })
    expect(calls.some((c) => c.fn === 'onChange' && c.args[0] === 'left')).toBe(false)
  })

  it('switching sides before any value is set writes nothing — it only changes where the NEXT value lands', () => {
    const calls: unknown[] = []
    renderPositionSection({
      currentStyles: { position: 'absolute' },
      storedStyles: { position: 'absolute' },
      onChange: (...args) => calls.push(args),
      onClearProperty: (...args) => calls.push(args),
    })

    const combobox = screen.getByRole('combobox', { name: 'X anchor side' })
    fireEvent.click(combobox.nextElementSibling as HTMLElement)
    fireEvent.click(screen.getByRole('option', { name: 'Right' }))

    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Z-index settings affordance (Law 2)
// ---------------------------------------------------------------------------

describe('PositionSection — z-index settings affordance', () => {
  it('keeps the z-index row collapsed behind the settings trigger until opened', () => {
    renderPositionSection({ storedStyles: { zIndex: 5 }, currentStyles: { zIndex: 5 } })

    expect(screen.queryByTestId('css-property-row-zIndex')).toBeNull()
    expect(screen.getByText('z 5')).toBeTruthy()

    fireEvent.click(screen.getByTestId('position-settings-trigger'))

    expect(screen.getByTestId('css-property-row-zIndex')).toBeTruthy()
  })

  it('shows no badge when z-index is unset', () => {
    renderPositionSection()
    expect(screen.queryByText(/^z /)).toBeNull()
  })
})
