/**
 * TextSection — Penpot's Text section (`STATE.md` `panel-25`, P3 item 9).
 *
 * Mounts `<TextSection />` against the store (`useSelectionModel`/
 * `useInspectorCommit`) rather than as a prop-driven component — the same
 * shift every migrated section's own test suite already made (see
 * `strokeSection.test.tsx`/`fillSection.test.tsx`).
 *
 * Covers, ported from the pre-migration `panels/PropertiesPanel/
 * __tests__/typographySection.test.tsx`:
 *   1. The four F23 rows at rest (family; weight+size; line-height+letter-
 *      spacing; text-align + vertical-align + the settings ⚙) — always
 *      resident (no Law-1 empty header — see `TextSection.tsx`'s own doc for
 *      why a text layer has no genuinely empty state) and no longer gated by
 *      a style search (P1 deleted the single-node search bar).
 *   2. Vertical align — honest write / disabled-with-a-reason, unchanged
 *      from the pre-migration file's own coverage.
 *   3. Code-locked properties — the write is refused, same posture every
 *      migrated section already established.
 *
 * `TextSettingsPopover`'s own Details/Variable/sticky-tab coverage moved to
 * `textSettingsPopover.test.tsx` — it is a leaf, props-driven component and
 * needs no store, the same split `imageFill.test.tsx` established for a
 * `FillSection` sub-part.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { TextSection } from '../TextSection'
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
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.text', props: { tag: 'p' }, ...overrides }),
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

// ---------------------------------------------------------------------------
// 1. The four rows at rest
// ---------------------------------------------------------------------------

describe('TextSection — F23 rows at rest', () => {
  it('renders family, weight+size, and line-height+letter-spacing', () => {
    selectNode({
      inlineStyles: { fontFamily: 'Inter', fontSize: '16px', lineHeight: '1.5' },
    })
    render(<TextSection />)

    expect(screen.getByTestId('css-property-row-fontFamily')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontWeight')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-fontSize')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-lineHeight')).toBeTruthy()
    expect(screen.getByTestId('css-property-row-letterSpacing')).toBeTruthy()
  })

  it('renders row 4 as a text-align group, a vertical-align group, and one settings trigger — not five resident property rows', () => {
    selectNode()
    render(<TextSection />)

    expect(screen.getByTestId('text-align')).toBeTruthy()
    expect(screen.getByTestId('text-vertical-align')).toBeTruthy()
    expect(screen.getByTestId('text-settings-trigger')).toBeTruthy()
    // The properties row 4 replaces are NOT drawn as their own resident rows.
    expect(screen.queryByTestId('css-property-row-fontStyle')).toBeNull()
    expect(screen.queryByTestId('css-property-row-textDecoration')).toBeNull()
    expect(screen.queryByTestId('css-property-row-textTransform')).toBeNull()
    expect(screen.queryByTestId('css-property-row-whiteSpace')).toBeNull()
  })

  // G9's target shape: a text node's colour is its FILL and a text shadow is
  // a SHADOW. Both are claimed by Fill/Shadow, never this section.
  it('no longer draws color or textShadow — they belong to Fill and Shadow', () => {
    selectNode()
    render(<TextSection />)

    expect(screen.queryByTestId('css-property-row-color')).toBeNull()
    expect(screen.queryByTestId('css-property-row-textShadow')).toBeNull()
  })

  it('always renders row 4, with no style search left to gate it', () => {
    // P1 deleted the single-node search bar — row 4 no longer has a
    // `visibleProperties` filter to hide behind.
    selectNode()
    render(<TextSection />)

    expect(screen.getByTestId('text-align')).toBeTruthy()
    expect(screen.getByTestId('text-settings-trigger')).toBeTruthy()
  })

  it('clicking a text-align segment writes textAlign', () => {
    selectNode()
    render(<TextSection />)

    fireEvent.click(screen.getByRole('button', { name: /text align: align center/i }))

    expect(currentNode()?.inlineStyles?.textAlign).toBe('center')
  })
})

// ---------------------------------------------------------------------------
// 2. Vertical align — honest write / disabled with a reason
// ---------------------------------------------------------------------------

describe('TextSection — vertical align honesty', () => {
  it('disables the vertical-align group with a reason when the element is not display:flex', () => {
    selectNode()
    render(<TextSection />)

    const group = screen.getByTestId('text-vertical-align')
    const buttons = group.querySelectorAll('button')
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('disables vertical align when flex-direction is column even though display is flex', () => {
    selectNode({ inlineStyles: { display: 'flex', flexDirection: 'column' } })
    render(<TextSection />)

    const group = screen.getByTestId('text-vertical-align')
    expect(group.querySelector('button')!.getAttribute('aria-disabled')).toBe('true')
  })

  it('enables vertical align and writes alignItems for a flex-row element', () => {
    selectNode({ inlineStyles: { display: 'flex', flexDirection: 'row' } })
    render(<TextSection />)

    const middleBtn = screen.getByRole('button', { name: 'Align middle' })
    expect(middleBtn.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(middleBtn)

    expect(currentNode()?.inlineStyles?.alignItems).toBe('center')
  })

  it('reflects a stored alignItems value back as the pressed vertical-align edge', () => {
    selectNode({ inlineStyles: { display: 'flex', alignItems: 'flex-end' } })
    render(<TextSection />)

    expect(screen.getByRole('button', { name: 'Align bottom' }).getAttribute('aria-pressed')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 3. Code-locked properties
// ---------------------------------------------------------------------------

describe('TextSection — code-locked properties', () => {
  it('refuses a fontSize write when fontSize is code-valued', () => {
    selectNode({
      inlineStyles: { fontSize: '16px' },
      codeProps: ['style:fontSize'],
    })
    render(<TextSection />)

    const fontSizeField = screen.getByTestId('css-property-row-fontSize').querySelector('input')!
    fireEvent.change(fontSizeField, { target: { value: '24px' } })
    fireEvent.blur(fontSizeField)

    expect(currentNode()?.inlineStyles?.fontSize).toBe('16px')
  })

  it('disables the vertical-align group with a reason when alignItems is code-valued', () => {
    selectNode({
      inlineStyles: { display: 'flex', flexDirection: 'row' },
      codeProps: ['style:alignItems'],
    })
    render(<TextSection />)

    const middleBtn = screen.getByRole('button', { name: 'Align middle' })
    expect(middleBtn.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(middleBtn)

    expect(currentNode()?.inlineStyles?.alignItems).toBeUndefined()
  })
})
