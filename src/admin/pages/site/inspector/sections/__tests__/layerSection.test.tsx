/**
 * LayerSection — Penpot's Layer section (`STATE.md` `panel-25`, P3 item 1).
 *
 * There is no old test to port from: `toggleNodeLocked` had ZERO existing
 * UI call sites before this section (see `LayerSection.tsx`'s own doc), so
 * every one of these is written fresh. The opacity/blend-mode assertions
 * ARE ported from `appearanceSection.test.tsx`'s "4. Blend mode" describe
 * block, onto the new component and its `commitApi` write path.
 *
 * Covers:
 *   1. The eye toggles `node.hidden` (structural), never `visibility` (CSS).
 *   2. The lock button is absent without `canEditStructure`.
 *   3. Opacity previews through `commitApi`'s preview channel mid-drag
 *      (`previewNodeStyles`), and only commits to the real node on release.
 *   4. The blend-mode menu writes `mixBlendMode` through `commitStyle`,
 *      clearing it (not writing the literal string `"normal"`) for Normal.
 *   5. A code-locked property disables its own field, not the whole row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { EditorPermissionsContext, type EditorPermissions } from '@site/editorPermissionsContext'
import { LayerSection } from '../LayerSection'
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

function pointerDown(el: Element, clientX: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX })
}
function pointerMove(el: Element, clientX: number) {
  fireEvent.pointerMove(el, { pointerId: 1, clientX })
}
function pointerUp(el: Element, clientX: number) {
  fireEvent.pointerUp(el, { pointerId: 1, clientX })
}

// ---------------------------------------------------------------------------
// 1. The structural eye — node.hidden, never CSS visibility
// ---------------------------------------------------------------------------

describe('LayerSection — structural visibility (the eye)', () => {
  it('toggles node.hidden and reads back the new state, leaving visibility untouched', () => {
    selectNode()
    render(<LayerSection />)

    const eye = screen.getByTestId('layer-visibility-toggle')
    expect(eye.getAttribute('aria-label')).toBe('Hide on canvas')

    fireEvent.click(eye)

    expect(currentNode()?.hidden).toBe(true)
    expect(currentNode()?.inlineStyles?.visibility).toBeUndefined()

    cleanup()
    render(<LayerSection />)
    const eyeAfter = screen.getByTestId('layer-visibility-toggle')
    expect(eyeAfter.getAttribute('aria-label')).toBe('Show on canvas')

    fireEvent.click(eyeAfter)
    expect(currentNode()?.hidden).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. The lock — new UI, gated by canEditStructure
// ---------------------------------------------------------------------------

describe('LayerSection — lock (new surface, zero prior UI)', () => {
  it('is absent when the caller cannot edit structure', () => {
    selectNode()
    const readOnlyStructure: EditorPermissions = {
      canEditStructure: false,
      canEditContent: true,
      canEditStyle: true,
    }
    render(
      <EditorPermissionsContext.Provider value={readOnlyStructure}>
        <LayerSection />
      </EditorPermissionsContext.Provider>,
    )

    expect(screen.queryByTestId('layer-lock-toggle')).toBeNull()
  })

  it('toggles node.locked when structure is editable (the default)', () => {
    selectNode()
    render(<LayerSection />)

    const lock = screen.getByTestId('layer-lock-toggle')
    expect(lock.getAttribute('aria-label')).toBe('Lock element')

    fireEvent.click(lock)

    expect(currentNode()?.locked).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Opacity — previews through commitApi's channel, commits on release
// ---------------------------------------------------------------------------

describe('LayerSection — opacity (commitApi preview channel)', () => {
  it('previews mid-drag without writing the real node, then commits on release', async () => {
    selectNode({ inlineStyles: { opacity: '50%' } })
    render(<LayerSection />)

    const label = screen.getByTestId('layer-opacity-label')
    pointerDown(label, 0)
    pointerMove(label, 10)
    await new Promise((resolve) => requestAnimationFrame(resolve))

    // Preview channel fired — the real node is untouched mid-drag.
    expect(useEditorStore.getState().previewNodeStyles).not.toBeNull()
    expect(useEditorStore.getState().previewNodeStyles?.nodeIds).toContain(NODE_ID)
    expect(currentNode()?.inlineStyles?.opacity).toBe('50%')

    pointerUp(label, 10)

    // Release commits the real value through commitStyle, not the preview
    // channel.
    expect(currentNode()?.inlineStyles?.opacity).toBe('60%')
  })
})

// ---------------------------------------------------------------------------
// 4. Blend mode — the F12 grouped droplet menu
// ---------------------------------------------------------------------------

describe('LayerSection — blend mode', () => {
  it('the droplet opens a grouped menu; picking a mode writes mixBlendMode', () => {
    selectNode()
    render(<LayerSection />)

    fireEvent.click(screen.getByTestId('layer-blend-mode-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Multiply' }))

    expect(currentNode()?.inlineStyles?.mixBlendMode).toBe('multiply')
  })

  it('picking Normal clears the property rather than writing the literal string', () => {
    selectNode({ inlineStyles: { mixBlendMode: 'multiply' } })
    render(<LayerSection />)

    fireEvent.click(screen.getByTestId('layer-blend-mode-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Normal' }))

    expect(currentNode()?.inlineStyles?.mixBlendMode).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Code-locked properties — the field disables, not the row
// ---------------------------------------------------------------------------

describe('LayerSection — code-locked properties', () => {
  it('disables only the opacity field when opacity is code-valued', () => {
    selectNode({ codeProps: ['style:opacity'] })
    render(<LayerSection />)

    const opacityField = screen.getByTestId('layer-opacity-field') as HTMLInputElement
    expect(opacityField.disabled).toBe(true)

    // The rest of the row stays live. The blend trigger always carries a
    // tooltip, so `Button` converts a disabled state to `aria-disabled`
    // (never native `disabled`) so the tooltip stays reachable on hover —
    // see `Button.tsx`'s own doc.
    const blendTrigger = screen.getByTestId('layer-blend-mode-trigger') as HTMLButtonElement
    expect(blendTrigger.getAttribute('aria-disabled')).toBeNull()
  })

  it('disables only the blend trigger when mixBlendMode is code-valued', () => {
    selectNode({ codeProps: ['style:mixBlendMode'] })
    render(<LayerSection />)

    const blendTrigger = screen.getByTestId('layer-blend-mode-trigger') as HTMLButtonElement
    expect(blendTrigger.getAttribute('aria-disabled')).toBe('true')

    const opacityField = screen.getByTestId('layer-opacity-field') as HTMLInputElement
    expect(opacityField.disabled).toBe(false)
  })
})
