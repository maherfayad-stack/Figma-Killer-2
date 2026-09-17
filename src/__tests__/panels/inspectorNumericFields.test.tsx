/**
 * Every numeric field in the inspector, on the same commit path.
 *
 * W8-2 wired the one scrub engine into the panel's remaining un-scrubbed
 * numerics — the TRBL insets, the constraint offsets, `gap`, all five corner
 * radii, `opacity`, `zIndex`, `fontSize`, `lineHeight`, `letterSpacing`. These
 * tests pin the part of that which is easy to get silently wrong: WHAT VALUE
 * LANDS. A field that gained a drag gesture but writes `opacity: 1px`, or
 * `line-height: 1.5px` where the user typed the ratio `1.5`, is worse than the
 * field that had no gesture at all.
 *
 * The gesture itself is covered by `scrubTokenField.test.tsx` (token-aware
 * half) and `ScrubInput/__tests__/scrubInput.test.tsx` (plain half); both
 * exercise the same `useScrubDrag` engine these fields now share.
 *
 * P3 (`STATE.md` `panel-25`) retired `AppearanceSection`/`PositionSection`/
 * the old `LayoutSection/GapInput` (Track P). The `ClassPropertyRow`-only
 * describes below (opacity/zIndex/lineHeight/letterSpacing/fontSize) are
 * untouched by that migration — `ClassPropertyRow` itself did not move or
 * change. "corner radius" and "position insets" are ported onto the sections
 * that now own that geometry (`RadiusCluster`/`MeasuresSection`, P3 item 3 —
 * see each file's own doc for "formerly AppearanceSection.tsx"/"ported
 * verbatim from the retired PositionSection.tsx"). The old "gap" describe is
 * deleted outright: the single `gap`-shorthand `GapInput` it drove no longer
 * exists — `GapRow.tsx` (P3 item 4) replaced it with a `rowGap`/`columnGap`
 * split, and the scrub-drag/clamp-at-zero gesture it exercised is the exact
 * same `ScrubTokenField` engine `scrubTokenField.test.tsx` already covers
 * generically (GapRow's fields are `ScrubTokenField`s with `min={0}`); the
 * row/column write path itself is covered by
 * `inspector/sections/__tests__/layoutSection.test.tsx`'s own "Row gap /
 * Column gap" describe block.
 */
import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from '@site/panels/PropertiesPanel/ClassPropertyRow'
import { RadiusCluster } from '@site/inspector/sections/RadiusCluster'
import { MeasuresSection } from '@site/inspector/sections/MeasuresSection'
import { isNudgeableProp, isUnitlessNumberProp } from '@site/panels/PropertiesPanel/cssControlTypes'
import { getPropertyFieldGlyph } from '@site/panels/PropertiesPanel/cssPropertyIcons'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

afterEach(cleanup)

const noop = () => {}

function pointerDrag(el: Element, from: number, to: number) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: from })
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to })
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to })
}

/** Type into a field and commit it the way a user does: blur. */
function typeAndBlur(input: HTMLElement, text: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input, { target: { value: text } })
}

// ---------------------------------------------------------------------------
// The unitless fields — the ones a px default would corrupt
// ---------------------------------------------------------------------------

describe('unitless numeric fields never gain a unit', () => {
  it('opacity: a typed bare number commits as a number, not "0.5px"', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(<ClassPropertyRow property="opacity" value={1} onChange={onChange} onRemove={noop} />)

    typeAndBlur(screen.getByLabelText('Opacity'), '0.5')

    expect(onChange).toHaveBeenLastCalledWith('opacity', 0.5)
  })

  it('opacity: a drag commits a unitless number', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(<ClassPropertyRow property="opacity" value={0} onChange={onChange} onRemove={noop} />)

    pointerDrag(screen.getByTestId('css-scrub-opacity-label'), 0, 1)

    expect(onChange).toHaveBeenLastCalledWith('opacity', 1)
  })

  it('opacity: a drag is clamped to 0..1 rather than emitting a meaningless value', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(<ClassPropertyRow property="opacity" value={1} onChange={onChange} onRemove={noop} />)

    pointerDrag(screen.getByTestId('css-scrub-opacity-label'), 0, 40)
    expect(onChange).not.toHaveBeenCalled() // already at max — nothing changed

    pointerDrag(screen.getByTestId('css-scrub-opacity-label'), 40, 0)
    expect(onChange).toHaveBeenLastCalledWith('opacity', 0)
  })

  it('zIndex: a typed bare number commits as a number, not "3px"', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(<ClassPropertyRow property="zIndex" value={0} onChange={onChange} onRemove={noop} />)

    typeAndBlur(screen.getByLabelText('Z index'), '3')

    expect(onChange).toHaveBeenLastCalledWith('zIndex', 3)
  })

  it('zIndex: a drag commits a unitless number', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(<ClassPropertyRow property="zIndex" value={0} onChange={onChange} onRemove={noop} />)

    pointerDrag(screen.getByTestId('css-scrub-zIndex-label'), 0, 5)

    expect(onChange).toHaveBeenLastCalledWith('zIndex', 5)
  })

  it('lineHeight: the ratio 1.5 stays 1.5 — a px default would silently change what it means', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <ClassPropertyRow property="lineHeight" value="1.4" onChange={onChange} onRemove={noop} />,
    )

    typeAndBlur(screen.getByLabelText('Line height'), '1.5')

    expect(onChange).toHaveBeenLastCalledWith('lineHeight', '1.5')
  })

  it('lineHeight: a value the user gave a unit keeps it — coercion only ever ADDS one', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <ClassPropertyRow property="lineHeight" value="1.4" onChange={onChange} onRemove={noop} />,
    )

    typeAndBlur(screen.getByLabelText('Line height'), '24px')

    expect(onChange).toHaveBeenLastCalledWith('lineHeight', '24px')
  })

  it('the unitless set and the nudge set agree: every unitless prop is nudgeable', () => {
    for (const prop of ['opacity', 'zIndex', 'lineHeight'] as const) {
      expect(isUnitlessNumberProp(prop)).toBe(true)
      expect(isNudgeableProp(prop)).toBe(true)
    }
    // letter-spacing: 1.5 is NOT valid CSS — a bare number there needs px.
    expect(isUnitlessNumberProp('letterSpacing')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The length fields — a bare number gets the field's unit, maths evaluates
// ---------------------------------------------------------------------------

describe('length fields coerce a bare number and evaluate arithmetic', () => {
  it('letterSpacing: a typed bare number gets px', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <ClassPropertyRow property="letterSpacing" value="0px" onChange={onChange} onRemove={noop} />,
    )

    typeAndBlur(screen.getByLabelText('Letter spacing'), '2')

    expect(onChange).toHaveBeenLastCalledWith('letterSpacing', '2px')
  })

  it('letterSpacing: arithmetic evaluates on commit', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <ClassPropertyRow property="letterSpacing" value="0px" onChange={onChange} onRemove={noop} />,
    )

    typeAndBlur(screen.getByLabelText('Letter spacing'), '100/2')

    expect(onChange).toHaveBeenLastCalledWith('letterSpacing', '50px')
  })

  it('letterSpacing: dragging its glyph scrubs the value', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <ClassPropertyRow property="letterSpacing" value="0px" onChange={onChange} onRemove={noop} />,
    )

    pointerDrag(screen.getByTestId('css-scrub-letterSpacing-label'), 0, 4)

    expect(onChange).toHaveBeenLastCalledWith('letterSpacing', '4px')
  })

  it('a glyphless numeric row still nudges and still coerces — it just has nothing to drag', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    expect(getPropertyFieldGlyph('borderTopWidth')).toBeUndefined()
    render(
      <ClassPropertyRow property="borderTopWidth" value="1px" onChange={onChange} onRemove={noop} />,
    )

    const input = screen.getByLabelText('Border top width')
    // No scrub field was rendered for it.
    expect(screen.queryByTestId('css-scrub-borderTopWidth-label')).toBeNull()
    // …but the §5 commit coercion still applies.
    typeAndBlur(input, '4+4')
    expect(onChange).toHaveBeenLastCalledWith('borderTopWidth', '8px')
  })
})

// ---------------------------------------------------------------------------
// fontSize — the token-aware field that had no mark at all
// ---------------------------------------------------------------------------

describe('fontSize', () => {
  it('now carries an in-field mark, and that mark scrubs', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    expect(getPropertyFieldGlyph('fontSize')).toBeDefined()
    render(<ClassPropertyRow property="fontSize" value="16px" onChange={onChange} onRemove={noop} />)

    pointerDrag(screen.getByTestId('css-token-field-fontSize-handle'), 0, 8)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('fontSize', '24px')
  })
})

// ---------------------------------------------------------------------------
// Corner radius — ported onto `RadiusCluster` (P3 item 3, formerly
// `AppearanceSection`'s radius-only remainder — see that file's own doc).
// Props are unchanged except `activeTab` is gone (the section reads the
// active breakpoint through `useSelectionModel()` itself, not a prop).
// ---------------------------------------------------------------------------

describe('corner radius', () => {
  function noop() {}

  function renderRadius(
    onChangeMany: (patch: Record<string, string | number | null>) => void,
    stored: Record<string, unknown> = {},
  ) {
    return render(
      <RadiusCluster storedStyles={stored} currentStyles={{}} onChange={noop} onChangeMany={onChangeMany} />,
    )
  }

  const LINKED_CLEARS = {
    borderTopLeftRadius: null,
    borderTopRightRadius: null,
    borderBottomRightRadius: null,
    borderBottomLeftRadius: null,
  }

  it('the linked field writes the shorthand with a coerced value', () => {
    const onChangeMany = mock((_patch: Record<string, string | number | null>) => {})
    renderRadius(onChangeMany)

    typeAndBlur(screen.getByLabelText('Corner radius, all corners'), '12')

    expect(onChangeMany.mock.calls).toEqual([[{ borderRadius: '12px', ...LINKED_CLEARS }]])
  })

  it('the linked field scrubs, clamped at zero', () => {
    const onChangeMany = mock((_patch: Record<string, string | number | null>) => {})
    renderRadius(onChangeMany, {
      borderTopLeftRadius: '4px',
      borderTopRightRadius: '4px',
      borderBottomRightRadius: '4px',
      borderBottomLeftRadius: '4px',
    })

    pointerDrag(screen.getByTestId('measures-radius-all-label'), 0, -40)

    expect(onChangeMany).toHaveBeenLastCalledWith({ borderRadius: '0px', ...LINKED_CLEARS })
    expect(onChangeMany.mock.calls.every(([patch]) => patch.borderRadius === '0px')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Position insets — ported onto `MeasuresSection` (P3 item 3), which mounts
// `DirectionInput`/`PositionConstraints` "ported verbatim from the retired
// `PositionSection.tsx`" (see `MeasuresSection.tsx`'s own doc). Unlike
// `ClassPropertyRow`/`RadiusCluster`, `MeasuresSection` takes no props — it
// reads/writes through `useSelectionModel()`/`useInspectorCommit()`, the
// same store-backed pattern every migrated section's own test file
// (`measuresSection.test.tsx`) already establishes. That file's own
// "absolute-mode constraints" describe covers the side-picker/crosshair; it
// does not exercise the scrub-drag gesture on either field, which is what
// this describe adds.
// ---------------------------------------------------------------------------

describe('position insets', () => {
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

  it('each TRBL field scrubs from its direction arrow', () => {
    selectNode({ inlineStyles: { position: 'relative', top: '10px' } })
    render(<MeasuresSection />)

    pointerDrag(screen.getByTestId('css-direction-top-handle'), 0, 6)

    expect(currentNode()?.inlineStyles?.top).toBe('16px')
  })

  it('the absolute-position constraint offset scrubs too', () => {
    selectNode({ inlineStyles: { position: 'absolute', left: '20px' } })
    render(<MeasuresSection />)

    pointerDrag(screen.getByTestId('css-constraint-input-left-right-handle'), 0, 5)

    expect(currentNode()?.inlineStyles?.left).toBe('25px')
  })
})
