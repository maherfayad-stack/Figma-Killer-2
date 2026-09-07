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
 */
import { describe, it, expect, mock, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from '@site/panels/PropertiesPanel/ClassPropertyRow'
import { AppearanceSection } from '@site/panels/PropertiesPanel/AppearanceSection'
import { GapInput } from '@site/panels/PropertiesPanel/LayoutSection/GapInput'
import { PositionSection } from '@site/panels/PropertiesPanel/PositionSection'
import {
  isNudgeableProp,
  isUnitlessNumberProp,
} from '@site/panels/PropertiesPanel/cssControlTypes'
import { getPropertyFieldGlyph } from '@site/panels/PropertiesPanel/cssPropertyIcons'

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
// Corner radius — five bare Inputs before this change
// ---------------------------------------------------------------------------

describe('corner radius', () => {
  function renderAppearance(
    onChange: (p: keyof CSSPropertyBag, v: string | number | undefined) => void,
    stored: Record<string, unknown> = {},
  ) {
    return render(
      <AppearanceSection
        storedStyles={stored}
        currentStyles={{}}
        activeTab="base"
        onChange={onChange}
        onRemove={noop}
      />,
    )
  }

  it('the linked field writes all four corners with a coerced value', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    renderAppearance(onChange)

    typeAndBlur(screen.getByLabelText('Corner radius, all corners'), '12')

    expect(onChange.mock.calls).toEqual([
      ['borderTopLeftRadius', '12px'],
      ['borderTopRightRadius', '12px'],
      ['borderBottomRightRadius', '12px'],
      ['borderBottomLeftRadius', '12px'],
    ])
  })

  it('the linked field scrubs, clamped at zero', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    renderAppearance(onChange, {
      borderTopLeftRadius: '4px',
      borderTopRightRadius: '4px',
      borderBottomRightRadius: '4px',
      borderBottomLeftRadius: '4px',
    })

    pointerDrag(screen.getByTestId('appearance-radius-all-label'), 0, -40)

    expect(onChange).toHaveBeenLastCalledWith('borderBottomLeftRadius', '0px')
    expect(onChange.mock.calls.every(([, value]) => value === '0px')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gap and the position insets
// ---------------------------------------------------------------------------

describe('gap', () => {
  it('scrubs from its in-field mark, clamped at zero', () => {
    const onChange = mock((_v: string | undefined) => {})
    render(<GapInput value="8px" isSet onChange={onChange} />)

    pointerDrag(screen.getByTestId('css-gap-input-handle'), 0, 4)
    expect(onChange).toHaveBeenLastCalledWith('12px')

    pointerDrag(screen.getByTestId('css-gap-input-handle'), 0, -40)
    expect(onChange).toHaveBeenLastCalledWith('0px')
  })
})

describe('position insets', () => {
  it('each TRBL field scrubs from its direction arrow', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <PositionSection
        currentStyles={{ position: 'relative' }}
        storedStyles={{ position: 'relative', top: '10px' }}
        activeTab="base"
        onChange={onChange}
        onRemove={noop}
        onClearProperty={noop}
      />,
    )

    pointerDrag(screen.getByTestId('css-direction-top-handle'), 0, 6)

    expect(onChange).toHaveBeenLastCalledWith('top', '16px')
  })

  it('the absolute-position constraint offset scrubs too', () => {
    const onChange = mock((_p: keyof CSSPropertyBag, _v: string | number | undefined) => {})
    render(
      <PositionSection
        currentStyles={{ position: 'absolute' }}
        storedStyles={{ position: 'absolute', left: '20px' }}
        activeTab="base"
        onChange={onChange}
        onRemove={noop}
        onClearProperty={noop}
      />,
    )

    pointerDrag(screen.getByTestId('css-constraint-input-left-right-handle'), 0, 5)

    expect(onChange).toHaveBeenLastCalledWith('left', '25px')
  })
})
