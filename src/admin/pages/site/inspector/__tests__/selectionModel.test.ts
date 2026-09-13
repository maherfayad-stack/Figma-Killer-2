/**
 * useSelectionModel — the P4 replacement for `usePropertiesPanelData.ts`'s
 * style/class/provenance slice. Covers the P1 write-target rule surviving
 * PER-PROPERTY (`resolveWriteTarget.ts`'s "resolved once from the first key"
 * landmine, fixed by exposing `writeTargetFor` on the model instead of
 * resolving a patch's target from its first key), the class-lock gate
 * (`classCssWritability.ts`), and the inline-writability gate (module
 * ownership, source lock, code-valued props).
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { useSelectionModel } from '../selectionModel'
import { makeSite, makePage, makeNode } from '../../../../../__tests__/fixtures'
import '@modules/base/index'

afterEach(cleanup)

function makeClass(id: string, overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id,
    name: 'card',
    kind: 'class',
    selector: '.card',
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

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

describe('useSelectionModel — no selection', () => {
  it('reports an empty model when nothing is selected', () => {
    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.selectedNode).toBeNull()
    expect(result.current.selectedNodeId).toBeNull()
    expect(result.current.isMultiSelect).toBe(false)
    expect(result.current.assignedClassRules).toEqual([])
    expect(result.current.writableClasses).toEqual([])
    expect(result.current.inlineWritable).toBe(false)
  })
})

describe('useSelectionModel — isMultiSelect', () => {
  it('flips only at two or more selected nodes', () => {
    useEditorStore.setState({ selectedNodeIds: ['a'] })
    const { result, rerender } = renderHook(() => useSelectionModel())
    expect(result.current.isMultiSelect).toBe(false)

    act(() => {
      useEditorStore.setState({ selectedNodeIds: ['a', 'b'] })
    })
    rerender()
    expect(result.current.isMultiSelect).toBe(true)
  })
})

describe('useSelectionModel — inline write target', () => {
  function loadPageWithNode(node: ReturnType<typeof makeNode>) {
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [node.id] }),
        [node.id]: node,
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: 'page-1',
      selectedNodeId: node.id,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('is the only target for a base module node with no classes', () => {
    loadPageWithNode(makeNode({ id: 'node-1', moduleId: 'base.div' }))

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.inlineWritable).toBe(true)
    expect(result.current.inlineLockReason).toBeNull()
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'inline' })
  })

  it('is unwritable for a pkg.* module, with a naming-the-cause lock reason', () => {
    loadPageWithNode(makeNode({ id: 'node-1', moduleId: 'pkg.SomeComponent' }))

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.inlineWritable).toBe(false)
    expect(result.current.inlineLockReason).toBe("Inline styles come from this component's own source.")
    expect(result.current.writeTargetFor('color')).toEqual({
      kind: 'none',
      reason: 'Nothing here can save this — the element has no writable class and its inline styles are locked.',
    })
  })

  it('is unwritable for a `.map` row (no writable source location)', () => {
    const nodeId = 'src/pages/Home.tsx:70:21#2'
    loadPageWithNode(
      makeNode({ id: nodeId, moduleId: 'base.div', lockReason: 'part of a repeated .map() row' }),
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.inlineWritable).toBe(false)
    expect(result.current.inlineLockReason).toBe(
      'This element is part of a repeated .map() row, so its style="" layer is written in code.',
    )
  })

  it('folds a code-valued property into the inline branch of the P1 rule, per property', () => {
    loadPageWithNode(
      makeNode({
        id: 'node-1',
        moduleId: 'base.div',
        inlineStyles: { color: 'red' },
        codeProps: ['style:color'],
      }),
    )

    const { result } = renderHook(() => useSelectionModel())
    // Node-level inlineWritable stays true — only THIS property is gated.
    expect(result.current.inlineWritable).toBe(true)
    // No class exists to fall back to, so the per-property rule reports 'none'
    // for the locked property even though the node itself is inline-writable.
    expect(result.current.writeTargetFor('color').kind).toBe('none')
    // An untouched property on the SAME node is unaffected.
    expect(result.current.writeTargetFor('backgroundColor')).toEqual({ kind: 'inline' })
  })
})

describe('useSelectionModel — class write target', () => {
  function loadPageWithNodeAndClass(classId: string, classOverrides: Partial<StyleRule> = {}) {
    const nodeId = 'node-1'
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: 'base.div', classIds: [classId] }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], styleRules: { [classId]: makeClass(classId, classOverrides) } }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('reads assignedClassRules through s.site?.styleRules, not s.site', () => {
    loadPageWithNodeAndClass('class-1')
    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.assignedClassRules.map((c) => c.id)).toEqual(['class-1'])
  })

  it('is the default write target for a node with exactly one unmapped-but-outside-Studio class', () => {
    // Not a `:body` root — outside a Studio session, "unmapped" costs the
    // user nothing (`classCssWritability.ts`'s own doc).
    loadPageWithNodeAndClass('class-1')

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.writableClasses).toEqual([{ classId: 'class-1', selector: '.card', lockReason: null }])
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'class', classId: 'class-1', selector: '.card' })
  })

  it('locks a class Studio cannot map to any file INSIDE a Studio session, falling back to inline', () => {
    const nodeId = 'src/pages/Home.tsx:12:4'
    const rootId = 'page-studio:body'
    const page = makePage({
      id: 'page-studio',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: 'base.div', classIds: ['sc-tailwind001'] }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], styleRules: { 'sc-tailwind001': makeClass('sc-tailwind001') } }),
      activePageId: 'page-studio',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.writableClasses[0]?.lockReason).not.toBeNull()
    // No writable class candidate remains, so the rule falls back to inline.
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'inline' })
  })

  it('falls back to a writable class when the winning source (inline) is code-locked', () => {
    const nodeId = 'node-1'
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({
          id: nodeId,
          moduleId: 'base.div',
          classIds: ['class-1'],
          inlineStyles: { color: 'red' },
          codeProps: ['style:color'],
        }),
      },
    })
    useEditorStore.setState({
      site: makeSite({
        pages: [page],
        styleRules: { 'class-1': makeClass('class-1', { styles: {} }) },
      }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { result } = renderHook(() => useSelectionModel())
    // Provenance's winner is inline (it's the only declared source), but it
    // is code-locked, so the rule falls through to the sole writable class —
    // never silently rewrites a DIFFERENT source than the one rendering.
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'class', classId: 'class-1', selector: '.card' })
  })
})
