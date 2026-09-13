/**
 * AlignSection — Penpot's Align row (`STATE.md` `panel-25`, P3 item 2).
 *
 * Covers:
 *   1. `resolveAlignWrite` — the pure honesty check behind every align
 *      button, ported VERBATIM from `positionSection.test.tsx`'s own
 *      "1. resolveAlignWrite" describe block (moved with the module itself,
 *      not re-derived).
 *   2. The align row wired to a real (mocked) canvas frame + page tree,
 *      through `commitApi` instead of the old `onChange` prop — ported from
 *      `positionSection.test.tsx`'s own "2. The align row..." describe
 *      block, with ONE deliberate behavior change: this file's own doc
 *      comment explains why the row now HIDES (rather than rendering fully
 *      disabled) when every edge is unavailable — real, confirmed Penpot
 *      behavior (`docs/audits/penpot-inspector-baseline/screenshots/`), not
 *      a guess.
 *   3. Code-locked `alignSelf`/`justifySelf` — new coverage, since
 *      `SingleNodeAlignRow` never had this check (this section's own top-
 *      level doc comment explains why it needed adding here).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { registerFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { AlignSection } from '../AlignSection'
import { resolveAlignWrite, type ParentLayoutInfo } from '../resolveAlignWrite'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// 1. resolveAlignWrite — pure honesty check (ported verbatim)
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
// 2. AlignSection against a real (mocked) canvas frame + page tree
// ---------------------------------------------------------------------------

describe('AlignSection — single-node align row', () => {
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

  let frameAdapters: PortalFrameAdapter[] = []

  afterEach(() => {
    document.body.innerHTML = ''
    for (const adapter of frameAdapters) adapter.dispose()
    frameAdapters = []
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
    const adapter = new PortalFrameAdapter(frameDoc)
    frameAdapters.push(adapter)
    registerFrameAdapter(frame, adapter)
    return el
  }

  function selectChild(childOverrides: Parameters<typeof makeNode>[0] = {}, children: string[] = ['child-1']) {
    const child = makeNode({ id: 'child-1', moduleId: 'base.div', ...childOverrides })
    const nodes: Record<string, ReturnType<typeof makeNode>> = { 'parent-1': makeNode({ id: 'parent-1', moduleId: 'base.div', children }), 'child-1': child }
    if (children.includes('child-2') && !nodes['child-2']) {
      nodes['child-2'] = makeNode({ id: 'child-2', moduleId: 'base.div' })
    }
    const page = makePage({ rootNodeId: 'parent-1', nodes })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id, selectedNodeId: 'child-1' })
    return page
  }

  function currentNode(id: string) {
    return useEditorStore.getState().site?.pages[0]?.nodes[id]
  }

  it('hides the align row entirely when no live canvas frame is rendering the parent', () => {
    selectChild()
    render(<AlignSection />)
    expect(screen.queryByTestId('inspector-align-row')).toBeNull()
  })

  it('hides the align row entirely for a node with no parent at all', () => {
    const page = makePage({ rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.div' }) } })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id, selectedNodeId: 'root' })
    render(<AlignSection />)
    expect(screen.queryByTestId('inspector-align-row')).toBeNull()
  })

  it('flex parent, sole child: clicking "left" writes the PARENT justifyContent as an inline style', async () => {
    const user = userEvent.setup()
    selectChild()
    mountCanvasNode('parent-1', { display: 'flex', flexDirection: 'row' })

    render(<AlignSection />)

    const leftBtn = screen.getByTestId('align-bar-left')
    expect(leftBtn.getAttribute('aria-disabled')).not.toBe('true')
    await user.click(leftBtn)

    expect(currentNode('parent-1')?.inlineStyles).toEqual({ justifyContent: 'flex-start' })
    // The child's own bag is untouched — this was a parent write.
    expect(currentNode('child-1')?.inlineStyles).toBeUndefined()
  })

  it('flex parent, sole child: clicking a cross-axis edge writes THIS node\'s own bag through commitApi, not the parent', async () => {
    const user = userEvent.setup()
    selectChild()
    mountCanvasNode('parent-1', { display: 'flex', flexDirection: 'row' })

    render(<AlignSection />)
    await user.click(screen.getByTestId('align-bar-top'))

    expect(currentNode('child-1')?.inlineStyles).toEqual({ alignSelf: 'flex-start' })
    // The parent must be untouched — this was a cross-axis, per-item write.
    expect(currentNode('parent-1')?.inlineStyles).toBeUndefined()
  })

  it('flex parent WITH siblings: the main-axis edges are disabled with a reason, cross axis stays honest', () => {
    selectChild({}, ['child-1', 'child-2'])
    mountCanvasNode('parent-1', { display: 'flex', flexDirection: 'row' })

    render(<AlignSection />)

    expect(screen.getByTestId('align-bar-left').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('align-bar-top').getAttribute('aria-disabled')).not.toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 3. Code-locked alignSelf/justifySelf — new coverage (see this file's own
//    top-level doc for why `SingleNodeAlignRow` never needed it).
// ---------------------------------------------------------------------------

describe('AlignSection — code-locked properties', () => {
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

  it('disables only the edges resolving to a code-locked property, on a grid parent (both axes are per-item there)', () => {
    const child = makeNode({ id: 'child-1', moduleId: 'base.div', codeProps: ['style:alignSelf'] })
    const parent = makeNode({ id: 'parent-1', moduleId: 'base.div', children: ['child-1'] })
    const page = makePage({ rootNodeId: 'parent-1', nodes: { 'parent-1': parent, 'child-1': child } })
    useEditorStore.setState({ site: makeSite({ pages: [page] }), activePageId: page.id, selectedNodeId: 'child-1' })
    mountCanvasNode('parent-1', { display: 'grid' })

    render(<AlignSection />)

    // 'top' resolves to alignSelf (vertical, grid) — locked.
    expect(screen.getByTestId('align-bar-top').getAttribute('aria-disabled')).toBe('true')
    // 'left' resolves to justifySelf (horizontal, grid) — untouched.
    expect(screen.getByTestId('align-bar-left').getAttribute('aria-disabled')).not.toBe('true')

    fireEvent.click(screen.getByTestId('align-bar-top'))
    expect(useEditorStore.getState().site?.pages[0]?.nodes['child-1']?.inlineStyles?.alignSelf).toBeUndefined()
  })
})
