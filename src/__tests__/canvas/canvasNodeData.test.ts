/**
 * canvasNodeData — a press must not make ~2,800 `NodeRenderer`s run seven
 * selectors each, but no write that CAN change a node's answer may be skipped.
 *
 * The skip list (`SELECTION_ONLY_KEYS`) is what the whole optimisation rests
 * on, so this file pins both halves: every listed key is a real store key (a
 * rename must not silently empty the list), and no per-node selector reads one
 * (a recording proxy over the real selectors — a selector that started
 * reading `selectedNodeIds` would go stale instead of slow, which is the one
 * failure this design must never have).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { PageNode } from '@core/page-tree'
import { selectCanvasPageFor, useEditorStore, type EditorStore } from '@site/store/store'
import { changesNodeData, SELECTION_ONLY_KEYS, useCanvasNodeData } from '@site/canvas/canvasNodeData'
import { getCanvasNodeClassName } from '@site/canvas/canvasNodeClassName'
import { resolveEditorFormPreviewState, resolveEditorFormPreviewSuccessMessage } from '@site/canvas/canvasFormPreview'
import { makePage, makeSite } from '../fixtures'

const node = (id: string, parentId: string | null, children: string[] = [], text = id): PageNode =>
  ({ id, moduleId: 'base.text', props: { text }, breakpointOverrides: {}, children, classIds: [], parentId }) as unknown as PageNode

function load(): void {
  const nodes: Record<string, PageNode> = { r: node('r', null, ['a', 'b']), a: node('a', 'r'), b: node('b', 'r') }
  useEditorStore.getState().loadSite(makeSite({ pages: [makePage({ id: 'p1', rootNodeId: 'r', nodes }), makePage({ id: 'p2', rootNodeId: 'r2', nodes: { r2: node('r2', null) } })] }))
  useEditorStore.getState().setActivePage('p1')
}

beforeEach(load)
afterEach(() => cleanup())

describe('the skip list', () => {
  it('names only real store keys', () => {
    const keys = new Set(Object.keys(useEditorStore.getState()))
    for (const key of SELECTION_ONLY_KEYS) expect(keys.has(key), `${key} is not a store key`).toBe(true)
  })

  it('is never read by a per-node selector', () => {
    const read = new Set<string>()
    const recording = new Proxy(useEditorStore.getState(), {
      get(target, key, receiver) {
        read.add(String(key))
        return Reflect.get(target, key, receiver)
      },
    }) as EditorStore
    // What `NodeRenderer`'s seven selectors call, for a board frame and for the CMS canvas, with and without a form preview.
    for (const pageId of ['p1', null]) {
      selectCanvasPageFor(recording, pageId, 'frame-1')?.nodes.a
      getCanvasNodeClassName(['c1'], null, 'a', recording.site?.styleRules)
    }
    resolveEditorFormPreviewState(recording, 'a')
    resolveEditorFormPreviewSuccessMessage(recording, 'a')
    useEditorStore.setState({ formPreviewStates: { x: 'success' } } as Partial<EditorStore>)
    resolveEditorFormPreviewState(new Proxy(useEditorStore.getState(), { get: (t, k, r) => (read.add(String(k)), Reflect.get(t, k, r)) }) as EditorStore, 'a')
    useEditorStore.setState({ formPreviewStates: {} } as Partial<EditorStore>)
    // The inline-edit and preview selectors are one-key reads.
    for (const key of ['activeInlineEdit', 'previewClassAssignment', 'previewNodeStyles']) read.add(key)

    const hit = [...read].filter((key) => SELECTION_ONLY_KEYS.has(key))
    expect(hit, 'a per-node selector reads a key whose writes the filter skips').toEqual([])
  })
})

describe('changesNodeData', () => {
  it('ignores the writes a press makes', () => {
    const s = useEditorStore.getState()
    expect(changesNodeData({ ...s, selectedNodeIds: ['a'], selectedNodeId: 'a', selectedNodeFrameId: 'f', focusedPanel: 'canvas', activeBreakpointId: 'studio', enteredInstanceIds: ['x'] }, s)).toBe(false)
  })

  it('a board frame’s nodes also ignore which page is active; the CMS canvas’s do not', () => {
    const s = useEditorStore.getState()
    const switched = { ...s, activePageId: 'p2', activeDocument: null, previousActivePageId: 'p1' }
    expect(changesNodeData(switched, s, true)).toBe(false)
    expect(changesNodeData(switched, s, false)).toBe(true)
  })

  it('...unless a form preview is live, which resolves its node against the active page', () => {
    const s = useEditorStore.getState()
    const previewing = { ...s, formPreviewStates: { form1: 'success' }, activePageId: 'p2' }
    expect(changesNodeData(previewing, s, true)).toBe(true)
  })

  it('wakes on everything else, however small', () => {
    const s = useEditorStore.getState()
    expect(changesNodeData({ ...s, site: { ...s.site! } }, s)).toBe(true)
    expect(changesNodeData({ ...s, activePageId: 'p2' }, s)).toBe(true)
    expect(changesNodeData({ ...s, previewClassAssignment: { nodeId: 'a' } as never }, s)).toBe(true)
    expect(changesNodeData({ ...s, someFutureKey: 1 } as never, s)).toBe(true)
  })
})

describe('useCanvasNodeData', () => {
  it('is not asked again by a selection, and is by an edit of its node', () => {
    let calls = 0
    const { result } = renderHook(() =>
      useCanvasNodeData((s) => {
        calls += 1
        return selectCanvasPageFor(s, 'p1', null)?.nodes.a?.props.text ?? null
      }, true),
    )
    expect(result.current).toBe('a')
    const afterMount = calls

    act(() => {
      useEditorStore.getState().selectNode('b', 'replace', { frameId: 'f1' })
      useEditorStore.getState().setFocusedPanel('canvas')
      useEditorStore.getState().setActiveBreakpoint('studio')
    })
    expect(calls).toBe(afterMount) // not a single selector call for three press writes

    act(() => {
      useEditorStore.getState().updateNodeProps('a', { text: 'edited' })
    })
    expect(result.current).toBe('edited')
  })

  it('reads the live state when it renders for another reason (a skipped write is never a stale read)', () => {
    const { result, rerender } = renderHook(() => useCanvasNodeData((s) => s.selectedNodeId, false))
    act(() => {
      useEditorStore.getState().selectNode('b', 'replace', { frameId: 'f1' })
    })
    rerender()
    expect(result.current).toBe('b')
  })
})
