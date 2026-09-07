/**
 * Mixed rendering across the inspector's control surfaces (W8-3 phase 1).
 *
 * Figma's contract for a multi-selection whose values disagree: show "Mixed"
 * rather than one member's value, and let the FIRST edit replace it with one
 * value everywhere. This file pins that contract on each control the
 * inspector renders a CSS value through, plus the row that dispatches to
 * them.
 *
 * Covers:
 *   1. `SegmentedControl` — no segment pressed, `data-mixed`, and the group's
 *      accessible name says "mixed" so blank ≠ unset for a screen reader.
 *   2. `Select` — "Mixed" in the trigger, no option's label showing.
 *   3. `Input` — "Mixed" placeholder over an empty field, `data-mixed`.
 *   4. `TokenAwareInput` — same, and the token draft starts empty rather than
 *      pre-filled with one member's value.
 *   5. `ColorValueInput` — "Mixed" placeholder instead of the colour hint.
 *   6. `ClassPropertyRow` — a `MIXED` cell reaches the right control as
 *      "mixed" instead of stringifying the symbol, and the first commit
 *      reports one real value to `onChange`.
 *   7. `StyleSectionsEditor` — `MIXED` in `storedStyles` counts as SET (the
 *      section's indicator/meta), and `MIXED` in `currentStyles` becomes the
 *      row's placeholder.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MIXED } from '@ui/components/MixedValue'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Select } from '@ui/components/Select'
import { Input } from '@ui/components/Input'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { ClassPropertyRow } from '../ClassPropertyRow'
import { StyleSectionsEditor } from '../StyleSectionsEditor'

afterEach(cleanup)

function noop() {}

// ---------------------------------------------------------------------------
// 1. SegmentedControl
// ---------------------------------------------------------------------------

describe('SegmentedControl — mixed', () => {
  const OPTIONS = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
  ] as const

  it('presses no segment and marks the group mixed', () => {
    render(
      <SegmentedControl
        value={MIXED}
        options={OPTIONS}
        onChange={noop}
        aria-label="Text align"
        data-testid="seg"
      />,
    )
    const group = screen.getByTestId('seg')
    expect(group.getAttribute('data-mixed')).toBe('true')
    expect(group.getAttribute('aria-label')).toBe('Text align (mixed)')
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-pressed')).not.toBe('true')
    }
  })

  it('commits the clicked value on the first edit', () => {
    const onChange = mock((_next: string) => {})
    render(
      <SegmentedControl value={MIXED} options={OPTIONS} onChange={onChange} aria-label="Text align" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Center' }))
    expect(onChange).toHaveBeenCalledWith('center')
  })
})

// ---------------------------------------------------------------------------
// 2. Select
// ---------------------------------------------------------------------------

describe('Select — mixed', () => {
  it('shows the Mixed placeholder instead of an option label', () => {
    render(
      <Select
        mixed
        value="flex"
        onChange={noop}
        aria-label="Display"
        data-testid="display-select"
        options={[
          { label: 'flex', value: 'flex' },
          { label: 'grid', value: 'grid' },
        ]}
      />,
    )
    const trigger = screen.getByTestId('display-select') as HTMLInputElement
    expect(trigger.value).toBe('')
    expect(trigger.getAttribute('placeholder')).toBe('Mixed')
    expect(trigger.getAttribute('data-mixed')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 3. Input
// ---------------------------------------------------------------------------

describe('Input — mixed', () => {
  it('replaces the caller placeholder with Mixed and flags the field', () => {
    render(<Input mixed value="" onChange={noop} placeholder="auto" aria-label="Width" />)
    const field = screen.getByLabelText('Width') as HTMLInputElement
    expect(field.getAttribute('placeholder')).toBe('Mixed')
    expect(field.getAttribute('data-mixed')).toBe('true')
  })

  it('leaves an ordinary field untouched', () => {
    render(<Input value="" onChange={noop} placeholder="auto" aria-label="Width" />)
    const field = screen.getByLabelText('Width') as HTMLInputElement
    expect(field.getAttribute('placeholder')).toBe('auto')
    expect(field.getAttribute('data-mixed')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. TokenAwareInput
// ---------------------------------------------------------------------------

describe('TokenAwareInput — mixed', () => {
  it('starts empty with the Mixed placeholder rather than one member’s value', () => {
    render(
      <TokenAwareInput
        mixed
        value="16px"
        tokens={[]}
        onCommit={noop}
        aria-label="Font size"
      />,
    )
    const field = screen.getByLabelText('Font size') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('commits the typed value on Enter', () => {
    const onCommit = mock((_v: string | undefined) => {})
    render(
      <TokenAwareInput mixed value="16px" tokens={[]} onCommit={onCommit} aria-label="Font size" />,
    )
    const field = screen.getByLabelText('Font size')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '20px' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('20px')
  })
})

// ---------------------------------------------------------------------------
// 5. ColorValueInput
// ---------------------------------------------------------------------------

describe('ColorValueInput — mixed', () => {
  it('shows Mixed instead of the colour-format hint', () => {
    render(
      <ColorValueInput
        mixed
        value=""
        ariaLabel="Text color"
        swatchLabel="Text color swatch"
        onChange={noop}
      />,
    )
    const field = screen.getByLabelText('Text color') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})

// ---------------------------------------------------------------------------
// 6. ClassPropertyRow — the dispatcher
// ---------------------------------------------------------------------------

describe('ClassPropertyRow — MIXED cell', () => {
  it('never stringifies the sentinel into a colour field', () => {
    render(
      <ClassPropertyRow property="color" value={MIXED} onChange={noop} onRemove={noop} />,
    )
    const field = screen.getByLabelText('Color') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })

  it('marks a text-typed property mixed', () => {
    render(
      <ClassPropertyRow property="lineHeight" value={MIXED} onChange={noop} onRemove={noop} />,
    )
    const field = screen.getByLabelText('Line height') as HTMLInputElement
    expect(field.getAttribute('data-mixed')).toBe('true')
    expect(field.value).toBe('')
  })

  it('reports one real value to onChange on the first edit', () => {
    const onChange = mock((_p: unknown, _v: unknown) => {})
    render(
      <ClassPropertyRow property="lineHeight" value={MIXED} onChange={onChange} onRemove={noop} />,
    )
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.5' } })
    expect(onChange).toHaveBeenCalledWith('lineHeight', '1.5')
  })
})

// ---------------------------------------------------------------------------
// 7. StyleSectionsEditor — MIXED through the bags
// ---------------------------------------------------------------------------

describe('StyleSectionsEditor — MIXED bags', () => {
  function renderEditor(
    storedStyles: Record<string, unknown>,
    currentStyles: Record<string, unknown> = {},
  ) {
    return render(
      <StyleSectionsEditor
        storedStyles={storedStyles}
        currentStyles={currentStyles}
        sectionKey="base"
        styleQuery=""
        onChange={noop}
        onRemove={noop}
        onClearProperty={noop}
        onClearProperties={noop}
        onPreview={noop}
        onClearPreview={noop}
      />,
    )
  }

  it('counts a MIXED property as set', () => {
    // `cursor` lives in the Interaction section, which is `collapsedWhenEmpty`
    // — so its indicator dot appearing at all is the assertion that MIXED
    // survived `hasStyleValue`.
    renderEditor({ cursor: MIXED })
    expect(screen.getByTestId('class-style-section-dot-interaction')).toBeTruthy()
  })

  it('turns a MIXED effective value into the row placeholder', () => {
    // A sibling property keeps the `collapsedWhenEmpty` section's body open
    // (Law 1) so the `cursor` row — unset on the target, mixed underneath —
    // actually renders.
    renderEditor({ pointerEvents: 'none' }, { cursor: MIXED })
    const field = screen.getByLabelText('Cursor') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})
