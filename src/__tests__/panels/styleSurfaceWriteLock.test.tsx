/**
 * `StyleSurface`'s pre-flight write lock, end to end at the panel level.
 *
 * Three facts:
 *
 *  1. A class Studio maps to a build artefact (or cannot map at all) is
 *     announced BEFORE the first keystroke, not by a toast 2 s after autosave.
 *  2. The banner offers the remedy its own wording recommends — switching to
 *     the element's inline-style layer, which DOES write back — instead of
 *     recommending it and leaving the user to find the chip.
 *  3. Outside Studio, where every class is "unmapped" simply because there is
 *     no file on disk to map to, nothing is locked. Getting this wrong would
 *     disable the whole properties panel in the DB-backed editor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { StyleSurface } from '@site/panels/PropertiesPanel/StyleSurface'
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

/** A board page (`<pageId>:body` root) with one source-derived node. */
function loadStudioPage() {
  const rootId = 'page-studio:body'
  const page = makePage({
    id: 'page-studio',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [STUDIO_NODE_ID] }),
      [STUDIO_NODE_ID]: makeNode({ id: STUDIO_NODE_ID, moduleId: 'base.text', children: [] }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-studio',
    inlineStyleEditing: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** The same shape, but a CMS page — a nanoid root, no source locations. */
function loadCmsPage() {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] }),
      [nodeId]: makeNode({ id: nodeId, moduleId: 'base.text', children: [] }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    inlineStyleEditing: false,
  } as Parameters<typeof useEditorStore.setState>[0])
  return nodeId
}

function renderSurface(cls: StyleRule, nodeId: string) {
  return render(
    <StyleSurface
      activeClass={cls}
      activeClassId={cls.id}
      assignedClassRules={[cls]}
      activeBreakpointId="desktop"
      nodeId={nodeId}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
})

describe('StyleSurface — pre-flight class write lock', () => {
  it('announces a compiled class before the user types, and marks the block locked', () => {
    loadStudioPage()
    const cls = makeClass('sc-abc1234567')
    setStudioStyleRuleSources({ [cls.id]: { file: 'dist/style.css', selector: '.card' } }, {})

    renderSurface(cls, STUDIO_NODE_ID)

    const notice = screen.getByTestId('class-css-locked-notice')
    expect(notice.textContent).toContain('.card')
    expect(notice.textContent).toContain('build/output directory')
    expect(screen.getByTestId('style-target-block-class').getAttribute('data-write-locked')).toBe('true')
  })

  it('offers the element as the remedy, and taking it opens the inline block', () => {
    loadStudioPage()
    const cls = makeClass('sc-abc1234567')
    setStudioStyleRuleSources({ [cls.id]: { file: 'dist/style.css', selector: '.card' } }, {})

    renderSurface(cls, STUDIO_NODE_ID)

    expect(useEditorStore.getState().inlineStyleEditing).toBe(false)
    act(() => {
      screen.getByRole('button', { name: 'Style the element instead' }).click()
    })
    expect(useEditorStore.getState().inlineStyleEditing).toBe(true)
  })

  it('locks an imported class Studio could not map to any file', () => {
    loadStudioPage()
    renderSurface(makeClass('sc-tailwind001'), STUDIO_NODE_ID)
    expect(screen.getByTestId('class-css-locked-notice')).toBeTruthy()
  })

  it('does not lock a class whose source is a hand-authored .css file', () => {
    loadStudioPage()
    const cls = makeClass('sc-abc1234567')
    setStudioStyleRuleSources({ [cls.id]: { file: 'src/pages/Home.css', selector: '.card' } }, {})

    renderSurface(cls, STUDIO_NODE_ID)

    expect(screen.queryByTestId('class-css-locked-notice')).toBeNull()
    expect(screen.getByTestId('style-target-block-class').getAttribute('data-write-locked')).toBe('false')
  })

  it('locks nothing outside a Studio session, where "unmapped" costs the user nothing', () => {
    const nodeId = loadCmsPage()
    renderSurface(makeClass('sc-tailwind001'), nodeId)
    expect(screen.queryByTestId('class-css-locked-notice')).toBeNull()
  })
})
