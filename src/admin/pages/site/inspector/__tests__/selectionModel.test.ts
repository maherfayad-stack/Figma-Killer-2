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
import { MIXED } from '@ui/components/MixedValue'
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

  // P5, STATE.md `panel-26`: additive field, unwrapped from
  // useFrameComputedStyleValues's new `{ value, isLoading }` shape. This
  // fixture registers no canvas frame at all (portal or bridge), so
  // `computedValues` stays null and `computedValuesLoading` stays false —
  // a bridge-mode `true` case is covered in isolation by
  // `useBridgeComputedValues.test.ts`, not duplicated here.
  it('exposes computedValuesLoading, false on a portal-only (no bridge frame) fixture', () => {
    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.computedValues).toBeNull()
    expect(result.current.computedValuesLoading).toBe(false)
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

  it('P3-C (OD-8) — a `.map` row is writable: its style goes to the row template', () => {
    const nodeId = 'src/pages/Home.tsx:70:21#2'
    loadPageWithNode(
      makeNode({ id: nodeId, moduleId: 'base.div', lockReason: 'part of a repeated .map() row' }),
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.inlineWritable).toBe(true)
    expect(result.current.inlineLockReason).toBeNull()
  })

  it('is unwritable for a source-derived node with neither a location nor a row template', () => {
    // `loopTemplateNodeId` refuses a row whose template would not decode —
    // the id grammar is the gate, so no template means no write.
    const nodeId = 'home:body'
    loadPageWithNode(makeNode({ id: nodeId, moduleId: 'base.div', lockReason: 'the page root' }))

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.inlineWritable).toBe(false)
    expect(result.current.inlineLockReason).toBe('This element is the page root, so its style="" layer is written in code.')
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

// ---------------------------------------------------------------------------
// S5 — the multi-selection widening. `docs/features/inspector.md` §9.0.
// ---------------------------------------------------------------------------

describe('useSelectionModel — N nodes', () => {
  /** Two sibling layers under one root, both selected (anchor last). */
  function loadTwoSelected(
    a: ReturnType<typeof makeNode>,
    b: ReturnType<typeof makeNode>,
    styleRules: Record<string, StyleRule> = {},
  ) {
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [a.id, b.id] }),
        [a.id]: a,
        [b.id]: b,
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], styleRules }),
      activePageId: 'page-1',
      selectedNodeId: b.id,
      selectedNodeIds: [a.id, b.id],
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('resolves every selected id, and collapses agreeing inline values to the shared one', () => {
    loadTwoSelected(
      { ...makeNode({ id: 'a', moduleId: 'base.div' }), inlineStyles: { color: 'red' } },
      { ...makeNode({ id: 'b', moduleId: 'base.div' }), inlineStyles: { color: 'red' } },
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.isMultiSelect).toBe(true)
    expect(result.current.selectedNodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(result.current.selectedNode?.inlineStyles?.color).toBe('red')
  })

  it('collapses a disagreement to the MIXED sentinel, never to one layer value', () => {
    loadTwoSelected(
      { ...makeNode({ id: 'a', moduleId: 'base.div' }), inlineStyles: { color: 'red' } },
      { ...makeNode({ id: 'b', moduleId: 'base.div' }), inlineStyles: { color: 'blue' } },
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.selectedNode?.inlineStyles?.color).toBe(MIXED)
  })

  it('treats "set on one, absent on the other" as a disagreement', () => {
    loadTwoSelected(
      { ...makeNode({ id: 'a', moduleId: 'base.div' }), inlineStyles: { color: 'red' } },
      makeNode({ id: 'b', moduleId: 'base.div' }),
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.selectedNode?.inlineStyles?.color).toBe(MIXED)
  })

  it('keeps a code lock only when EVERY selected layer carries it, and counts the rest', () => {
    loadTwoSelected(
      { ...makeNode({ id: 'a', moduleId: 'base.div' }), codeProps: ['style:color', 'style:width'] },
      { ...makeNode({ id: 'b', moduleId: 'base.div' }), codeProps: ['style:color'] },
    )

    const { result } = renderHook(() => useSelectionModel())
    // `color` is locked on both -> the control refuses. `width` is locked on
    // one of two -> the write still lands on the other, so it stays offered.
    expect(result.current.selectedNode?.codeProps).toEqual(['style:color'])
    expect(result.current.blockedPropertyCounts.get('color')).toBe(2)
    expect(result.current.blockedPropertyCounts.get('width')).toBe(1)
  })

  it('excludes a layer whose module takes no inline style from the write, and names it', () => {
    loadTwoSelected(
      makeNode({ id: 'a', moduleId: 'base.div' }),
      makeNode({ id: 'b', moduleId: 'pkg.SomeComponent' }),
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.inlineWritableNodeIds).toEqual(['a'])
    expect(result.current.inlineUnwritableNodes.map((n) => n.id)).toEqual(['b'])
    // One layer still takes the write, so the control is NOT disabled.
    expect(result.current.inlineWritable).toBe(true)
  })

  it('offers no class target until one is picked, and pins to Element meanwhile', () => {
    loadTwoSelected(
      makeNode({ id: 'a', moduleId: 'base.div', classIds: ['class-1'] }),
      makeNode({ id: 'b', moduleId: 'base.div', classIds: ['class-1'] }),
      { 'class-1': makeClass('class-1') },
    )

    const { result } = renderHook(() => useSelectionModel())
    // The shared class is REPORTED (the chip needs it) but is not a write
    // target until the user picks it and clears the blast-radius gate.
    expect(result.current.sharedClassRules.map((r) => r.id)).toEqual(['class-1'])
    expect(result.current.assignedClassRules).toEqual([])
    expect(result.current.writeTargetFor('color')).toEqual({ kind: 'inline' })
  })

  it('reports no shared class when only one layer carries it', () => {
    loadTwoSelected(
      makeNode({ id: 'a', moduleId: 'base.div', classIds: ['class-1'] }),
      makeNode({ id: 'b', moduleId: 'base.div' }),
      { 'class-1': makeClass('class-1') },
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.sharedClassRules).toEqual([])
  })

  it('never claims a computed value it could not measure across N elements', () => {
    loadTwoSelected(
      makeNode({ id: 'a', moduleId: 'base.div' }),
      makeNode({ id: 'b', moduleId: 'base.div' }),
    )

    const { result } = renderHook(() => useSelectionModel())
    expect(result.current.computedValues).toBeNull()
  })
})
