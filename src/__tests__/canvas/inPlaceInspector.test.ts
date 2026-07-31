/**
 * inPlaceInspector — pure-function tests for the mini-inspector's schema
 * filtering, plus `findNodeById`'s node resolution (WS-5.2). Rendering/
 * geometry/anchoring is a human dogfood — not covered here.
 *
 * `visibleInspectorControls` is fully deterministic (no DOM, no store) and
 * mirrors the exact filtering `renderModuleTabContent` applies before
 * handing a schema entry to `PropertyControlRenderer`: drop `hidden`
 * controls, drop controls whose `condition` doesn't match current props.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { findNodeById } from '@site/canvas/InPlaceInspector/findNodeById'
import { visibleInspectorControls } from '@site/canvas/InPlaceInspector/visibleInspectorControls'
import type { PropertySchema } from '@core/module-engine'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { makeNode, makePage, makeSite, makeVC } from '../fixtures'

describe('visibleInspectorControls', () => {
  it('returns every entry when none are hidden or conditional', () => {
    const schema: PropertySchema = {
      label: { type: 'text', label: 'Label' },
      size: {
        type: 'select',
        label: 'Size',
        options: [{ label: 'Small', value: 'sm' }],
      },
    }
    const result = visibleInspectorControls(schema, {})
    expect(result.map(([key]) => key)).toEqual(['label', 'size'])
  })

  it('drops controls with hidden: true', () => {
    const schema: PropertySchema = {
      label: { type: 'text', label: 'Label' },
      internal: { type: 'text', label: 'Internal', hidden: true },
    }
    const result = visibleInspectorControls(schema, {})
    expect(result.map(([key]) => key)).toEqual(['label'])
  })

  it('drops a control whose condition does not match current props', () => {
    const schema: PropertySchema = {
      variant: {
        type: 'select',
        label: 'Variant',
        options: [{ label: 'Icon', value: 'icon' }],
      },
      iconName: {
        type: 'text',
        label: 'Icon name',
        condition: { field: 'variant', eq: 'icon' },
      },
    }

    const hidden = visibleInspectorControls(schema, { variant: 'text' })
    expect(hidden.map(([key]) => key)).toEqual(['variant'])

    const shown = visibleInspectorControls(schema, { variant: 'icon' })
    expect(shown.map(([key]) => key)).toEqual(['variant', 'iconName'])
  })

  it('evaluates a compound (and/or) condition', () => {
    const schema: PropertySchema = {
      mode: { type: 'text', label: 'Mode' },
      count: { type: 'number', label: 'Count' },
      advanced: {
        type: 'toggle',
        label: 'Advanced',
        condition: {
          and: [
            { field: 'mode', notEq: 'simple' },
            { field: 'count', in: [2, 3] },
          ],
        },
      },
    }

    expect(
      visibleInspectorControls(schema, { mode: 'complex', count: 3 }).map(([key]) => key),
    ).toEqual(['mode', 'count', 'advanced'])

    expect(
      visibleInspectorControls(schema, { mode: 'simple', count: 3 }).map(([key]) => key),
    ).toEqual(['mode', 'count'])
  })

  it('returns an empty array for an empty schema', () => {
    expect(visibleInspectorControls({}, {})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// findNodeById — WS-5.2: O(1) index lookup, many-valued across pages
// ---------------------------------------------------------------------------

const SHARED_ID = 'app/blog/layout.tsx:4:7'

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
    _nodeIdToPageIds: new Map(),
    _textOriginKeyToCount: new Map(),
    _inlineTailToCount: new Map(),
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('findNodeById', () => {
  beforeEach(freshStore)

  it('returns null when there is no site', () => {
    expect(findNodeById(useEditorStore.getState(), 'anything')).toBeNull()
  })

  it('resolves a plain (non-shared) node id', () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: ['alm-1'] }),
              'alm-1': makeNode({ id: 'alm-1', moduleId: 'alm.button' }),
            },
          }),
        ],
      }),
    )
    const node = findNodeById(useEditorStore.getState(), 'alm-1')
    expect(node?.moduleId).toBe('alm.button')
  })

  it('prefers the ACTIVE page when a node id is shared across pages (meta-05)', () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [
          makePage({
            id: 'page-a',
            slug: 'blog-a',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: [SHARED_ID] }),
              [SHARED_ID]: makeNode({ id: SHARED_ID, moduleId: 'alm.nav', props: { label: 'from-a' } }),
            },
          }),
          makePage({
            id: 'page-b',
            slug: 'blog-b',
            nodes: {
              root: makeNode({ id: 'root', moduleId: 'base.body', children: [SHARED_ID] }),
              [SHARED_ID]: makeNode({ id: SHARED_ID, moduleId: 'alm.nav', props: { label: 'from-b' } }),
            },
          }),
        ],
      }),
    )

    useEditorStore.setState({ activePageId: 'page-a' })
    expect(findNodeById(useEditorStore.getState(), SHARED_ID)?.props.label).toBe('from-a')

    useEditorStore.setState({ activePageId: 'page-b' })
    expect(findNodeById(useEditorStore.getState(), SHARED_ID)?.props.label).toBe('from-b')
  })

  it('falls back to a Visual Component tree node when active document is that VC', () => {
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [makePage({ id: 'page-a' })],
        visualComponents: [makeVC({ id: 'vc-one', name: 'One' })],
      }),
    )
    useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId: 'vc-one' })

    const node = findNodeById(useEditorStore.getState(), 'vc-root')
    expect(node?.moduleId).toBe('base.container')
  })

  it('returns null for an id that exists nowhere', () => {
    useEditorStore.getState().loadSite(makeSite({ pages: [makePage({ id: 'page-a' })] }))
    expect(findNodeById(useEditorStore.getState(), 'ghost')).toBeNull()
  })
})
