/**
 * AttributesSection — Studio's own "Attributes" section (`STATE.md`
 * `panel-25`, P3 item 11 — Studio extras). Ported + rewritten from
 * `src/__tests__/panels/htmlAttributesPanel.test.tsx` — no more tab-click
 * (`PropertiesPanelBody.tsx`'s Styles/Attributes switcher is deleted), the
 * section renders inline. Mounts `<AttributesSection />` directly against
 * the store, same pattern every migrated section's own test suite already
 * established.
 *
 * `inspector/sections/index.ts` no longer mounts this section in the panel
 * (direct user feedback, "remove attributes") — the component and its
 * `htmlAttributesModel.ts` are kept in place, unmounted but intact, since
 * `htmlAttributes` is a real prop other consumers still read (see that
 * file's own doc). This suite still exercises the component directly so it
 * stays honest and working while unmounted, not silently bit-rotting.
 *
 * Covers:
 *   1. Existing attributes render as name/value rows.
 *   2. Editing a value commits through `commitProp('htmlAttributes', …)`.
 *   3. Adding a brand-new attribute from empty commits it.
 *   4. `readOnly` — a structurally-locked node (or a `codeProps`-locked
 *      `htmlAttributes`) disables every control.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { AttributesSection } from '../AttributesSection'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
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

describe('AttributesSection — rendering', () => {
  it('renders existing attributes as name/value rows', () => {
    selectNode({ props: { htmlAttributes: { id: 'hero-image', 'data-track': 'hero' } } })
    render(<AttributesSection />)

    expect(screen.getByDisplayValue('id')).toBeTruthy()
    expect(screen.getByDisplayValue('hero-image')).toBeTruthy()
    expect(screen.getByDisplayValue('data-track')).toBeTruthy()
  })

  it('renders the empty state when no attributes are set', () => {
    selectNode({ props: {} })
    render(<AttributesSection />)

    expect(screen.getByText('No attributes set')).toBeTruthy()
  })
})

describe('AttributesSection — round-trip', () => {
  it('editing a value commits the new attribute bag immediately', () => {
    selectNode({ props: { htmlAttributes: { id: 'hero-image' } } })
    render(<AttributesSection />)

    fireEvent.change(screen.getByRole('textbox', { name: /id value/i }), {
      target: { value: 'lead-image' },
    })

    expect(currentNode()?.props.htmlAttributes).toEqual({ id: 'lead-image' })
  })

  it('adds the first authored attribute from an empty panel', () => {
    selectNode({ props: {} })
    render(<AttributesSection />)

    fireEvent.click(screen.getByRole('button', { name: /^add attribute$/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /^attribute name$/i }), {
      target: { value: 'id' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: /^id value$/i }), {
      target: { value: 'hero-title' },
    })

    expect(currentNode()?.props.htmlAttributes).toEqual({ id: 'hero-title' })
  })
})

describe('AttributesSection — readOnly', () => {
  it('disables every control when htmlAttributes is code-valued', () => {
    selectNode({
      props: { htmlAttributes: { id: 'hero-image' } },
      codeProps: ['htmlAttributes'],
    })
    render(<AttributesSection />)

    expect(screen.getByDisplayValue('id')).toHaveProperty('disabled', true)
    expect(screen.getByDisplayValue('hero-image')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /^add attribute$/i })).toHaveProperty('disabled', true)
  })
})
