/**
 * AppearanceSection — the section that didn't exist yet
 * (docs/features/inspector-disclosure.md §4 G5).
 *
 * Covers:
 *   1. Opacity and the radius cluster render in one row (F10); radius
 *      expands to four corner fields (F11) and collapsing/expanding never
 *      calls `onChange` on its own.
 *   2. `linked` is derived purely from whether all four corners are equal —
 *      a write while linked fans out to all four keys; a write to one
 *      expanded corner touches only that key.
 *   3. Section placement: Appearance sits between Spacing and Background,
 *      and — unlike Background/Border/Effects — is NOT hidden behind the
 *      empty-section "+" (Law 1 does not apply to it).
 *   4. The blend-mode droplet menu writes `mixBlendMode`, and once curated
 *      here the property is excluded from the generic Custom properties list.
 *   5. The eye writes `visibility: hidden` — not `display: none` — and its
 *      wording is distinct from the layer tree's hide/unhide.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { StyleSectionsEditor } from '../StyleSectionsEditor'
import { AppearanceSection, AppearanceSectionActions } from '../AppearanceSection'
import { getCustomProperties, isCuratedProperty } from '../cssControlTypes'

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
    <AppearanceSection
      storedStyles={{}}
      currentStyles={{}}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      {...overrides}
    />,
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
// 1 + 2. Opacity + radius cluster
// ---------------------------------------------------------------------------

describe('AppearanceSection — opacity + radius row', () => {
  it('renders opacity and a single collapsed radius field together when all four corners are equal', () => {
    renderAppearance({
      storedStyles: {
        opacity: 1,
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px',
        borderBottomRightRadius: '4px',
        borderBottomLeftRadius: '4px',
      },
    })
    setRadiusExpanded(false)

    expect(screen.getByTestId('css-property-row-opacity')).toBeTruthy()
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
    expect(screen.getByTestId('css-property-row-opacity')).toBeTruthy()

    // Background, right next to it, DOES collapse when empty — the contrast
    // proves this isn't an accidental panel-wide default.
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Blend mode
// ---------------------------------------------------------------------------

describe('AppearanceSection — blend mode (F12)', () => {
  it('curates mixBlendMode, excluding it from the generic Custom properties list', () => {
    expect(isCuratedProperty('mixBlendMode')).toBe(true)
    expect(isCuratedProperty('visibility')).toBe(true)
    expect(
      getCustomProperties({ mixBlendMode: 'multiply', someUnknownProp: 'x' }),
    ).toEqual(['someUnknownProp'])
  })

  it('the droplet opens a grouped menu; picking a mode writes mixBlendMode', () => {
    const calls: Array<[string, unknown]> = []
    render(
      <AppearanceSectionActions
        storedStyles={{}}
        onChange={(p, v) => calls.push([String(p), v])}
      />,
    )

    fireEvent.click(screen.getByTestId('appearance-blend-mode-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Multiply' }))

    expect(calls).toEqual([['mixBlendMode', 'multiply']])
  })

  it('picking Normal clears the property rather than writing the literal string', () => {
    const calls: Array<[string, unknown]> = []
    render(
      <AppearanceSectionActions
        storedStyles={{ mixBlendMode: 'multiply' }}
        onChange={(p, v) => calls.push([String(p), v])}
      />,
    )

    fireEvent.click(screen.getByTestId('appearance-blend-mode-trigger'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Normal' }))

    expect(calls).toEqual([['mixBlendMode', undefined]])
  })
})

// ---------------------------------------------------------------------------
// 5. Visibility eye — distinct from the layer tree's hide
// ---------------------------------------------------------------------------

describe('AppearanceSection — visibility eye (F10)', () => {
  it('writes visibility: hidden, and its label names the "keeps its space" behaviour', () => {
    const calls: Array<[string, unknown]> = []
    render(
      <AppearanceSectionActions
        storedStyles={{}}
        onChange={(p, v) => calls.push([String(p), v])}
      />,
    )

    const eye = screen.getByTestId('appearance-visibility-toggle')
    // Distinct wording from the layer tree's "Hide" / "Unhide" (which removes
    // the node from the page) — the whole point of G5's item 4.
    expect(eye.getAttribute('aria-label')).toBe('Hide element (keeps its space)')

    fireEvent.click(eye)

    expect(calls).toEqual([['visibility', 'hidden']])
  })

  it('clicking again clears visibility rather than writing "visible"', () => {
    const calls: Array<[string, unknown]> = []
    render(
      <AppearanceSectionActions
        storedStyles={{ visibility: 'hidden' }}
        onChange={(p, v) => calls.push([String(p), v])}
      />,
    )

    const eye = screen.getByTestId('appearance-visibility-toggle')
    expect(eye.getAttribute('aria-label')).toBe('Show element')

    fireEvent.click(eye)

    expect(calls).toEqual([['visibility', undefined]])
  })
})
