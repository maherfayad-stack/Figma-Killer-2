/**
 * AppearanceSection — the corner-radius remainder
 * (docs/features/inspector-disclosure.md §4 G5; `STATE.md` `panel-25`).
 *
 * Opacity/blend-mode/visibility moved to `LayerSection` — see
 * `layerSection.test.tsx` for those assertions, ported from this file's own
 * previous shape. This file now covers only what `AppearanceSection` still
 * renders:
 *   1. The radius cluster; expands to four corner fields (F11) and
 *      collapsing/expanding never calls `onChange` on its own.
 *   2. `linked` is derived purely from whether all four corners are equal —
 *      a write while linked fans out to all four keys; a write to one
 *      expanded corner touches only that key.
 *   3. Section placement: Appearance sits between Spacing and Background,
 *      and — unlike Background/Border/Effects — is NOT hidden behind the
 *      empty-section "+" (Law 1 does not apply to it).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { StyleSectionsEditor } from '../StyleSectionsEditor'
import { AppearanceSection } from '../AppearanceSection'

/** Multi-property write channel — see `StyleSectionsEditor`'s `onChangeMany`. */
function noopMany() {}

afterEach(cleanup)

function noop() {}

type EditorProps = ComponentProps<typeof StyleSectionsEditor>

function renderEditor(overrides: Partial<EditorProps> = {}) {
  return render(
    <StyleSectionsEditor
      storedStyles={{}}
      currentStyles={{}}
      sectionKey="base"
      styleQuery=""
      onChange={noop}
      onChangeMany={noopMany}
      onRemove={noop}
      onClearProperty={noop}
      onClearProperties={noop}
      onPreview={noop}
      onClearPreview={noop}
      {...overrides}
    />,
  )
}

type AppearanceProps = ComponentProps<typeof AppearanceSection>

function renderAppearance(overrides: Partial<AppearanceProps> = {}) {
  return render(
    <AppearanceSection storedStyles={{}} currentStyles={{}} onChange={noop} {...overrides} />,
  )
}

/** The radius fields are `ScrubInput`s, which put `data-testid` on the field
 * WRAPPER (the shell that also carries the draggable mark) and `-field` on the
 * `<input>` itself. Read the text box through this. */
function radiusInput(id: string): HTMLInputElement {
  return screen.getByTestId(`appearance-radius-${id}-field`) as HTMLInputElement
}

/** A `ScrubInput` commits on blur / Enter, not per keystroke — §5.4. Typing
 * without committing is a draft, so an edit test has to do both. */
function editRadius(id: string, value: string) {
  const input = radiusInput(id)
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input, { target: { value } })
}

/** Forces the radius cluster's collapse state to `expected`, sidestepping
 * its per-cluster-id sticky state (a module-level Map keyed by `id="radius"`
 * that survives remounts by design — see `ExpandableFieldCluster`'s doc). */
function setRadiusExpanded(expected: boolean) {
  const toggle = screen.getByTestId('expandable-field-cluster-radius-toggle')
  const isExpanded = toggle.getAttribute('aria-expanded') === 'true'
  if (isExpanded !== expected) fireEvent.click(toggle)
}

// ---------------------------------------------------------------------------
// 1 + 2. Radius cluster
// ---------------------------------------------------------------------------

describe('AppearanceSection — radius cluster', () => {
  it('renders a single collapsed radius field when all four corners are equal', () => {
    renderAppearance({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
    })
    setRadiusExpanded(false)

    expect(radiusInput('all').value).toBe('4px')
    expect(screen.queryByTestId('appearance-radius-TopLeft')).toBeNull()
  })

  it('expands to four independent corner fields, and toggling never calls onChange', () => {
    const onChange = mock(() => {})
    renderAppearance({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '8px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
      onChange,
    })

    setRadiusExpanded(true)
    expect(radiusInput('TopLeft').value).toBe('4px')
    expect(radiusInput('TopRight').value).toBe('8px')
    expect(radiusInput('BottomRight').value).toBe('4px')
    expect(radiusInput('BottomLeft').value).toBe('4px')

    setRadiusExpanded(false)
    setRadiusExpanded(true)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('linked (uniform corners): editing the collapsed field writes all four corner keys', () => {
    const calls: Array<[string, unknown]> = []
    renderAppearance({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
      onChange: (p, v) => calls.push([String(p), v]),
    })
    setRadiusExpanded(false)

    editRadius('all', '10px')

    expect(calls).toContainEqual(['borderTopLeftRadius', '10px'])
    expect(calls).toContainEqual(['borderTopRightRadius', '10px'])
    expect(calls).toContainEqual(['borderBottomRightRadius', '10px'])
    expect(calls).toContainEqual(['borderBottomLeftRadius', '10px'])
    expect(calls).toHaveLength(4)
  })

  it('unlinked (mixed corners): editing one expanded corner writes only that key', () => {
    const calls: Array<[string, unknown]> = []
    renderAppearance({
      storedStyles: {
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '8px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
      onChange: (p, v) => calls.push([String(p), v]),
    })
    setRadiusExpanded(true)

    editRadius('TopRight', '12px')

    expect(calls).toEqual([['borderTopRightRadius', '12px']])
  })
})

// ---------------------------------------------------------------------------
// 3. Section placement
// ---------------------------------------------------------------------------

describe('AppearanceSection — placement in StyleSectionsEditor', () => {
  it('sits between Spacing and Background in document order', () => {
    renderEditor()
    const ids = Array.from(document.querySelectorAll('[data-style-section]')).map((el) =>
      el.getAttribute('data-style-section'),
    )
    const spacingIndex = ids.indexOf('spacing')
    const appearanceIndex = ids.indexOf('appearance')
    const backgroundIndex = ids.indexOf('fill')

    expect(spacingIndex).toBeGreaterThanOrEqual(0)
    expect(appearanceIndex).toBeGreaterThan(spacingIndex)
    expect(backgroundIndex).toBeGreaterThan(appearanceIndex)
  })

  it('is never hidden behind the empty-section "+" — its controls are always resident', () => {
    renderEditor()
    expect(screen.queryByRole('button', { name: /add appearance/i })).toBeNull()
    // The radius cluster's expand/collapse state is sticky-by-design across
    // remounts (`ExpandableFieldCluster`'s own doc, `setRadiusExpanded`'s own
    // comment above) — normalize it before asserting the collapsed field's
    // own testid exists.
    setRadiusExpanded(false)
    expect(screen.getByTestId('appearance-radius-all')).toBeTruthy()

    // Background, right next to it, DOES collapse when empty — the contrast
    // proves this isn't an accidental panel-wide default.
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeDefined()
  })
})
