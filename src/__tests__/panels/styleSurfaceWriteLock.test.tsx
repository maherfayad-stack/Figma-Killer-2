/**
 * The panel's pre-flight class write lock, end to end.
 *
 * Track P / `panel-21` replaced the old exclusive Element/Class block pair
 * (and its dedicated `ClassCssLockedNotice` banner) with ONE merged
 * composer plus an informational chip strip — see `resolveWriteTarget.ts`. A
 * locked class no longer disables a whole block: it is struck through on its
 * chip, excluded from `resolveWriteTarget`'s candidates, and a NEW value for
 * a property that class would have owned now lands on the element's inline
 * layer instead — never silently discarded, never claimed by a control that
 * can't save it.
 *
 * panel-41 moved the chips themselves: they used to be `WriteTargetRow`, a
 * read-only strip inside the Design tab's scroll container listing the same
 * selectors `ClassPicker`'s pills already listed 40px above. The facts now
 * ride those pills, so this file renders `ClassPicker` — same store setup,
 * same `write-target-chip-*` test ids, same three facts.
 *
 * Three facts this file still checks:
 *
 *  1. A class Studio maps to a build artefact (or cannot map at all) is
 *     announced BEFORE the first keystroke (struck through, with a reason),
 *     not by a toast 2 s after autosave.
 *  2. That class is excluded from the merged composer's writable targets —
 *     confirmed indirectly via the chip's `data-locked` attribute.
 *  3. Outside Studio, where every class is "unmapped" simply because there
 *     is no file on disk to map to, nothing is locked. Getting this wrong
 *     would disable the whole properties panel in the DB-backed editor.
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { ClassPicker } from '@site/panels/PropertiesPanel/ClassPicker'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

const STUDIO_NODE_ID = 'src/pages/Home.tsx:12:4'

function makeClass(id: string): StyleRule {
  return {
    id,
    name: 'card',
    kind: 'class',
    selector: '.card',
    order: 0,
    styles: { color: 'red' },
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  } as StyleRule
}

/**
 * A board page (`<pageId>:body` root) with one source-derived node, carrying
 * `cls` in its `classIds` so `useSelectionModel()` resolves the SAME
 * `assignedClassRules` this file used to pass to `StyleSurface` as a prop
 * directly (P4 — `StyleSurface` reads the selection out of the store now,
 * not props; see `selectionModel.ts`).
 */
function loadStudioPage(cls: StyleRule) {
  const rootId = 'page-studio:body'
  const page = makePage({
    id: 'page-studio',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [STUDIO_NODE_ID] }),
      [STUDIO_NODE_ID]: makeNode({
        id: STUDIO_NODE_ID,
        moduleId: 'base.text',
        children: [],
        classIds: [cls.id],
      }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page], styleRules: { [cls.id]: cls } }),
    activePageId: 'page-studio',
    selectedNodeId: STUDIO_NODE_ID,
    activeBreakpointId: 'desktop',
    inlineStyleEditing: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** The same shape, but a CMS page — a nanoid root, no source locations. */
function loadCmsPage(cls: StyleRule) {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
      [nodeId]: makeNode({ id: nodeId, moduleId: 'base.text', children: [], classIds: [cls.id] }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page], styleRules: { [cls.id]: cls } }),
    activePageId: 'page-1',
    selectedNodeId: nodeId,
    activeBreakpointId: 'desktop',
    inlineStyleEditing: false,
  } as Parameters<typeof useEditorStore.setState>[0])
  return nodeId
}

function renderSurface(nodeId: string = STUDIO_NODE_ID) {
  return render(<ClassPicker nodeId={nodeId} />)
}

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
})

describe('StyleSurface — pre-flight class write lock', () => {
  it('announces a compiled class before the user types, struck through in the write-target chip row', () => {
    const cls = makeClass('sc-abc1234567')
    setStudioStyleRuleSources({ [cls.id]: { file: 'dist/style.css', selector: '.card' } }, {})
    loadStudioPage(cls)

    renderSurface()

    const chip = screen.getByTestId(`write-target-chip-${cls.id}`)
    expect(chip.getAttribute('data-locked')).toBe('true')
    expect(chip.textContent).toContain('.card')

    // Excluded from the merged composer's candidates — the element's inline
    // layer becomes the default target instead of silently failing.
    const inlineChip = screen.getByTestId('write-target-chip-inline')
    expect(inlineChip.getAttribute('data-default')).toBe('true')
  })

  it('locks an imported class Studio could not map to any file', () => {
    loadStudioPage(makeClass('sc-tailwind001'))
    renderSurface()
    expect(screen.getByTestId('write-target-chip-sc-tailwind001').getAttribute('data-locked')).toBe('true')
  })

  it('does not lock a class whose source is a hand-authored .css file', () => {
    const cls = makeClass('sc-abc1234567')
    setStudioStyleRuleSources({ [cls.id]: { file: 'src/pages/Home.css', selector: '.card' } }, {})
    loadStudioPage(cls)

    renderSurface()

    expect(screen.getByTestId(`write-target-chip-${cls.id}`).getAttribute('data-locked')).toBe('false')
  })

  it('locks nothing outside a Studio session, where "unmapped" costs the user nothing', () => {
    const nodeId = loadCmsPage(makeClass('sc-tailwind001'))
    renderSurface(nodeId)
    expect(screen.getByTestId('write-target-chip-sc-tailwind001').getAttribute('data-locked')).toBe('false')
  })
})
