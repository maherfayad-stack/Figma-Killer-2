/**
 * useInspectorCommit — the "one commit API" replacing every ad-hoc write
 * call site in the single-selection style path
 * (`WriteTargetStyleComposer.tsx`'s 8 raw store-action calls).
 *
 * Covers: the single-context null-set vs cross-context purge distinction
 * `StyleSectionsEditor.tsx`'s own doc names for `onRemove`/`onChangeMany`
 * vs `onClearProperty`/`onClearProperties`; the preview channel routing to
 * `setPreviewNodeStyles`/`setPreviewClassStyles` instead of committing
 * history; `commitProp`'s breakpoint-override rule ported verbatim from
 * `usePropertiesPanelData.ts`'s old `handleChange`; and the all-or-nothing
 * refusal of a code-valued property (refuses the WHOLE key, not just its
 * inline branch — see `commitApi.ts`'s own doc).
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { registry } from '@core/module-engine'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { useSelectionModel } from '../selectionModel'
import { useInspectorCommit } from '../commitApi'
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

function useTestHook() {
  const model = useSelectionModel()
  return { model, commit: useInspectorCommit(model) }
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

describe('useInspectorCommit — inline target', () => {
  it('commitStyle writes a new value to inline styles', () => {
    const nodeId = 'node-1'
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: 'base.div' }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyle('color', 'blue')
    })

    const node = useEditorStore.getState().site?.pages[0]?.nodes[nodeId]
    expect(node?.inlineStyles?.color).toBe('blue')
  })

  it('refuses the WHOLE key for a code-valued property, even though a writable class also exists', () => {
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
          codeProps: ['style:color'],
        }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], styleRules: { 'class-1': makeClass('class-1') } }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyle('color', 'blue')
    })

    const site = useEditorStore.getState().site!
    expect(site.pages[0]?.nodes[nodeId]?.inlineStyles?.color).toBeUndefined()
    expect(site.styleRules['class-1']?.styles.color).toBeUndefined()
  })
})

describe('useInspectorCommit — class target', () => {
  function loadPageWithClass(styles: Partial<StyleRule['styles']> = {}) {
    const nodeId = 'node-1'
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: 'base.div', classIds: ['class-1'] }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], styleRules: { 'class-1': makeClass('class-1', { styles }) } }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])
    return nodeId
  }

  it('commitStyleMany (mode "set") writes to base styles at the default context', () => {
    loadPageWithClass()
    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyleMany({ color: 'blue', fontSize: '14px' })
    })

    const cls = useEditorStore.getState().site?.styleRules['class-1']
    expect(cls?.styles.color).toBe('blue')
    expect(cls?.styles.fontSize).toBe('14px')
    expect(cls?.contextStyles?.mobile).toBeUndefined()
  })

  it('commitStyleMany (mode "set") writes to the active breakpoint context, not base', () => {
    loadPageWithClass({ color: 'red' })
    useEditorStore.setState({ activeBreakpointId: 'mobile' })

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyleMany({ color: 'blue' })
    })

    const cls = useEditorStore.getState().site?.styleRules['class-1']
    expect(cls?.styles.color).toBe('red') // base untouched
    expect(cls?.contextStyles?.mobile?.color).toBe('blue')
  })

  it('commitStyle(value=null) is a single-context null-set, not a cross-context purge', () => {
    loadPageWithClass({ color: 'red' })
    useEditorStore.setState({ activeBreakpointId: 'mobile' })
    // Give the class a mobile override too, so we can prove ONLY it clears —
    // base survives, matching `onRemove`'s old single-context behaviour.
    useEditorStore.getState().setClassContextStyles('class-1', 'mobile', { color: 'blue' })

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyle('color', null, { existing: true })
    })

    const cls = useEditorStore.getState().site?.styleRules['class-1']
    expect(cls?.styles.color).toBe('red') // base context untouched
    // `setClassContextStyles` removes a key set to null from the override
    // bag entirely — a single-context null-set, not a cross-context purge.
    expect(cls?.contextStyles?.mobile?.color).toBeUndefined()
  })

  it('commitStyleMany (mode "clear") purges base AND every context override in one call', () => {
    loadPageWithClass({ color: 'red', fontSize: '12px' })
    useEditorStore.getState().setClassContextStyles('class-1', 'mobile', { color: 'blue' })

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyleMany({ color: null }, { mode: 'clear' })
    })

    const cls = useEditorStore.getState().site?.styleRules['class-1']
    expect(cls?.styles.color).toBeUndefined()
    expect(cls?.contextStyles?.mobile?.color).toBeUndefined()
    expect(cls?.styles.fontSize).toBe('12px') // untouched property survives
  })
})

describe('useInspectorCommit — preview channel', () => {
  it('commitStyle({preview:true}) previews on the inline channel without pushing history', () => {
    const nodeId = 'node-1'
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: 'base.div' }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitStyle('color', 'blue', { preview: true })
    })

    expect(useEditorStore.getState().previewNodeStyles).toEqual({
      nodeIds: [nodeId],
      styles: { color: 'blue' },
    })
    // Not committed to the document.
    expect(useEditorStore.getState().site?.pages[0]?.nodes[nodeId]?.inlineStyles?.color).toBeUndefined()

    act(() => {
      result.current.commit.clearStylePreview()
    })
    expect(useEditorStore.getState().previewNodeStyles).toBeNull()
  })
})

describe('useInspectorCommit — commitProp', () => {
  const MODULE_ID = 'commit-api-test.module'

  beforeEach(() => {
    const definition: AnyModuleDefinition = {
      id: MODULE_ID,
      name: 'CommitApiTest',
      category: 'Test',
      version: '1.0.0',
      trusted: true,
      canHaveChildren: false,
      schema: {
        size: { type: 'text', label: 'Size', breakpointOverridable: true },
        label: { type: 'text', label: 'Label' },
      },
      defaults: { size: 'md', label: 'Hi' },
      component: () => null as never,
      render: () => ({ html: '<div></div>' }),
    }
    registry.registerOrReplace(definition)
  })

  function loadPageWithModule() {
    const nodeId = 'node-1'
    const rootId = 'root'
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: {
        [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
        [nodeId]: makeNode({ id: nodeId, moduleId: MODULE_ID, props: { size: 'md', label: 'Hi' } }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: 'page-1',
      selectedNodeId: nodeId,
    } as Parameters<typeof useEditorStore.setState>[0])
    return nodeId
  }

  it('routes a breakpointOverridable prop to setBreakpointOverride at a non-default breakpoint', () => {
    const nodeId = loadPageWithModule()
    useEditorStore.setState({ activeBreakpointId: 'mobile' })

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitProp('size', 'lg')
    })

    const node = useEditorStore.getState().site?.pages[0]?.nodes[nodeId]
    expect(node?.props.size).toBe('md') // base prop untouched
    expect(node?.breakpointOverrides?.mobile?.size).toBe('lg')
  })

  it('routes a non-overridable prop to updateNodeProps regardless of breakpoint', () => {
    const nodeId = loadPageWithModule()
    useEditorStore.setState({ activeBreakpointId: 'mobile' })

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitProp('label', 'Hello')
    })

    const node = useEditorStore.getState().site?.pages[0]?.nodes[nodeId]
    expect(node?.props.label).toBe('Hello')
    expect(node?.breakpointOverrides?.mobile?.label).toBeUndefined()
  })

  it('routes an overridable prop to updateNodeProps at the default (desktop) breakpoint', () => {
    const nodeId = loadPageWithModule()

    const { result } = renderHook(() => useTestHook())
    act(() => {
      result.current.commit.commitProp('size', 'lg')
    })

    const node = useEditorStore.getState().site?.pages[0]?.nodes[nodeId]
    expect(node?.props.size).toBe('lg')
  })
})
