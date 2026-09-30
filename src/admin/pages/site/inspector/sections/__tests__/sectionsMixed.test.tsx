/**
 * The four `PropertyList`-shaped Design-tab sections under a multi-selection
 * that DISAGREES — Fill, Layer, and Effects' shadow and blur rows (`STATE.md` `panel-38`,
 * `docs/features/inspector.md` §9.3).
 *
 * S5 widened `useSelectionModel()` to N nodes, which puts the `MIXED` Symbol
 * into the collapsed bag every section reads. These four kept reading it
 * through `readString` (which returns `undefined` for a Symbol) or through an
 * `as string | number` cast, and each failed a different way:
 *
 *   - **Fill** under-stated — the colour/shorthand rows VANISHED and the
 *     background stack silently read as "no layers", so "nobody set a fill"
 *     and "five layers set five different fills" looked identical.
 *   - **Blur** produced an EMPTY body under a section Law 1 had already
 *     forced open, with its add menu still enabled.
 *   - **Layer** showed the 100% opacity fallback, an unset blend trigger and
 *     an unpressed CSS-visibility toggle.
 *   - **Shadow** LIED: `String(MIXED)` is legal, so the raw refusal row read
 *     `Symbol(studio-mixed-value)` and offered to write it to disk.
 *
 * Every case below selects two sibling layers that disagree and asserts the
 * control says "Mixed", plus the two contract halves §9.1 promises: one edit
 * reaches BOTH nodes, in ONE history entry.
 *
 * These sections are store-backed (`useSelectionModel`/`useInspectorCommit`),
 * not prop-driven, which is why they cannot live in
 * `PropertiesPanel/__tests__/bespokeSectionsMixed.test.tsx` — that file's own
 * doc records each migration as it happened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PageNode } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { FillSection } from '../FillSection'
import { LayerSection } from '../LayerSection'
import { EffectsSection } from '../EffectsSection'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const A = 'node-a'
const B = 'node-b'
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

/**
 * Two sibling layers under one root, BOTH selected with `b` as the anchor
 * (`selectedNodeIds`'s last entry, the store's own convention) — the same
 * fixture shape `selectionModel.test.ts` established for S5.
 */
function selectTwo(aStyles: Record<string, unknown>, bStyles: Record<string, unknown>) {
  const a = { ...makeNode({ id: A, moduleId: 'base.div' }), inlineStyles: aStyles } as PageNode
  const b = { ...makeNode({ id: B, moduleId: 'base.div' }), inlineStyles: bStyles } as PageNode
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [A, B] }),
      [A]: a,
      [B]: b,
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: B,
    selectedNodeIds: [A, B],
  } as Parameters<typeof useEditorStore.setState>[0])
}

function inlineStyles(nodeId: string): Record<string, unknown> {
  return (useEditorStore.getState().site?.pages[0]?.nodes[nodeId]?.inlineStyles ?? {}) as Record<string, unknown>
}

/**
 * The shared store's past stack is capped and coalesces bursts, so "exactly
 * one more entry" is only measurable from a known-empty stack
 * (`measuresSection.test.tsx` documents the same precondition).
 */
function resetHistory() {
  useEditorStore.setState({ _historyPast: [], _historyCoalesceKey: null } as Parameters<
    typeof useEditorStore.setState
  >[0])
}

function historyLength(): number {
  return useEditorStore.getState()._historyPast.length
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

describe('FillSection — Mixed', () => {
  it('keeps the Text row and reads Mixed in its own colour field', () => {
    selectTwo({ color: '#112233' }, { color: '#445566' })
    render(<FillSection />)

    const field = screen.getByRole('textbox', { name: 'Text colour' }) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('drops the % opacity cell while mixed — there is no single alpha to show', () => {
    selectTwo({ color: '#112233' }, { color: '#445566' })
    render(<FillSection />)
    expect(screen.queryByRole('textbox', { name: 'Text colour opacity' })).toBeNull()
  })

  it('one typed colour reaches BOTH layers, in one history entry', () => {
    selectTwo({ color: '#112233' }, { color: '#445566' })
    render(<FillSection />)
    resetHistory()

    const field = screen.getByRole('textbox', { name: 'Text colour' })
    fireEvent.change(field, { target: { value: '#00ff00' } })
    fireEvent.blur(field)

    expect(inlineStyles(A).color).toBe('#00ff00')
    expect(inlineStyles(B).color).toBe('#00ff00')
    expect(historyLength()).toBe(1)
  })

  it('keeps the Solid fill row and reads Mixed there too', () => {
    selectTwo({ backgroundColor: '#fff' }, { backgroundColor: '#000' })
    render(<FillSection />)

    const field = screen.getByRole('textbox', { name: 'Solid fill colour' }) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('treats "set on one, absent on the other" as a disagreement, not as unset', () => {
    selectTwo({ backgroundColor: '#fff' }, {})
    render(<FillSection />)

    const field = screen.getByRole('textbox', { name: 'Solid fill colour' }) as HTMLInputElement
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('collapses a disagreeing background stack into ONE Mixed row, not per-layer rows', () => {
    selectTwo(
      { backgroundImage: 'linear-gradient(90deg, #f00 0%, #00f 100%)' },
      { backgroundImage: "url('/a.png')" },
    )
    render(<FillSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0] as HTMLElement).getByText('Mixed')).toBeTruthy()
    // No per-layer blend select: there is no shared layer to hang one on.
    expect(screen.queryByTestId('fill-layer-0-blend')).toBeNull()
  })

  it('disables the two layer-add buttons while the stack is mixed', () => {
    selectTwo(
      { backgroundImage: 'linear-gradient(90deg, #f00 0%, #00f 100%)' },
      { backgroundImage: "url('/a.png')" },
    )
    render(<FillSection />)

    // `Button` converts `disabled` + `tooltip` into `aria-disabled` so the
    // reason can still be hovered — see its own doc.
    expect(screen.getByRole('button', { name: /add gradient fill/i }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: /add image fill/i }).getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps per-layer rows when the stack AGREES and only a satellite disagrees', () => {
    const image = 'linear-gradient(90deg, #f00 0%, #00f 100%)'
    selectTwo(
      { backgroundImage: image, backgroundSize: 'cover' },
      { backgroundImage: image, backgroundSize: 'contain' },
    )
    render(<FillSection />)

    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByTestId('fill-layer-0-blend')).toBeTruthy()
  })

  it('keeps the background-shorthand row and reads Mixed in its raw field', () => {
    selectTwo({ background: 'red' }, { background: 'blue' })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('listitem'))
    const field = screen.getByRole('textbox', { name: 'background, raw CSS' }) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

describe('LayerSection — Mixed', () => {
  it('reads Mixed on opacity instead of the 100% fallback', () => {
    selectTwo({ opacity: '50%' }, { opacity: '20%' })
    render(<LayerSection />)

    const field = screen.getByTestId('layer-opacity-field') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('one typed opacity reaches BOTH layers, in one history entry', () => {
    selectTwo({ opacity: '50%' }, { opacity: '20%' })
    render(<LayerSection />)
    resetHistory()

    const field = screen.getByTestId('layer-opacity-field')
    fireEvent.change(field, { target: { value: '80' } })
    fireEvent.blur(field)

    expect(inlineStyles(A).opacity).toBe('80%')
    expect(inlineStyles(B).opacity).toBe('80%')
    expect(historyLength()).toBe(1)
  })

  it('names the disagreement on the blend trigger and claims no menu option', () => {
    selectTwo({ mixBlendMode: 'multiply' }, { mixBlendMode: 'screen' })
    render(<LayerSection />)

    const trigger = screen.getByTestId('layer-blend-mode-trigger')
    expect(trigger.getAttribute('aria-label')).toBe('Blend mode: Mixed')

    fireEvent.click(trigger)
    for (const item of screen.getAllByRole('menuitemradio')) {
      expect(item.getAttribute('aria-checked')).toBe('false')
    }
  })

  it('does not read a disagreeing CSS visibility as "not hidden"', () => {
    selectTwo({ visibility: 'hidden' }, {})
    render(<LayerSection />)

    const toggle = screen.getByTestId('layer-css-visibility-toggle')
    expect(toggle.getAttribute('aria-label')).toContain('Mixed')
  })
})

// ---------------------------------------------------------------------------
// Effects — shadows (the former Shadow section, merged in P2-F)
// ---------------------------------------------------------------------------

describe('EffectsSection — Mixed shadows', () => {
  it('never renders the stringified sentinel into the raw shadow field', () => {
    selectTwo({ boxShadow: '0 1px 2px #000' }, { boxShadow: '0 4px 8px #333' })
    render(<EffectsSection />)

    expect(screen.queryByText(/Symbol\(/)).toBeNull()
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Mixed')).toBeTruthy()
  })

  it('offers the whole declaration as a Mixed field in the row popover', () => {
    selectTwo({ boxShadow: '0 1px 2px #000' }, { boxShadow: '0 4px 8px #333' })
    render(<EffectsSection />)

    fireEvent.click(screen.getByRole('listitem'))
    const field = screen.getByRole('textbox', { name: /box.?shadow/i }) as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('disables the drop/inner shadow add items while box-shadow is mixed', () => {
    selectTwo({ boxShadow: '0 1px 2px #000' }, { boxShadow: '0 4px 8px #333' })
    render(<EffectsSection />)

    fireEvent.click(screen.getByTestId('effects-section-add'))
    // `Button` converts `disabled` + `tooltip` into `aria-disabled` so the
    // reason can still be hovered — see its own doc.
    expect(screen.getByRole('menuitem', { name: 'Drop shadow' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('menuitem', { name: 'Inner shadow' }).getAttribute('aria-disabled')).toBe('true')
    // `text-shadow` agrees (both unset), so its own item stays live.
    expect(screen.getByRole('menuitem', { name: 'Text shadow' }).getAttribute('aria-disabled')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Effects — blurs (the former Blur section, merged in P2-F)
// ---------------------------------------------------------------------------

describe('EffectsSection — Mixed blurs', () => {
  it('renders a Mixed row rather than an empty body under a forced-open section', () => {
    selectTwo({ filter: 'blur(4px)' }, { filter: 'blur(12px)' })
    render(<EffectsSection />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Mixed')).toBeTruthy()
  })

  it('one typed filter reaches BOTH layers, in one history entry', () => {
    selectTwo({ filter: 'blur(4px)' }, { filter: 'blur(12px)' })
    render(<EffectsSection />)

    fireEvent.click(screen.getByRole('listitem'))
    const field = screen.getByRole('textbox', { name: /filter/i })
    resetHistory()
    fireEvent.change(field, { target: { value: 'blur(2px)' } })
    fireEvent.blur(field)

    expect(inlineStyles(A).filter).toBe('blur(2px)')
    expect(inlineStyles(B).filter).toBe('blur(2px)')
    expect(historyLength()).toBe(1)
  })

  it('disables "Add layer blur" while filter is mixed', () => {
    selectTwo({ filter: 'blur(4px)' }, { filter: 'blur(12px)' })
    render(<EffectsSection />)

    fireEvent.click(screen.getByTestId('effects-section-add'))
    // `Button` converts `disabled` + `tooltip` into `aria-disabled`, so the
    // "different values here" reason can still be hovered.
    expect(screen.getByRole('menuitem', { name: 'Layer blur' }).getAttribute('aria-disabled')).toBe('true')
  })
})
