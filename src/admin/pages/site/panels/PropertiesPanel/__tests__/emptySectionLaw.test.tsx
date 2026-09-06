/**
 * StyleSectionsEditor — the empty-section law
 * (docs/features/inspector-disclosure.md §1 Law 1 / §4 G1).
 *
 * `collapsedWhenEmpty` sections (background / border / effects / interaction /
 * typography) render as a single header line with a "+" when nothing is set —
 * ANYWHERE, not just on the active breakpoint/condition tab — and must never
 * collapse while an active style search is filtering the panel. The
 * always-present sections (position / size / layout / spacing) are untouched
 * by this law and keep their controls resident regardless of whether anything
 * is set.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { StyleSectionsEditor } from '../StyleSectionsEditor'

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

describe('StyleSectionsEditor — empty-section law (G1)', () => {
  it('(a) an empty collapsible section renders its header only, with a "+"', () => {
    renderEditor()

    // Typography is `collapsedWhenEmpty` and nothing is set anywhere — no
    // property grid, just the header line and its "+".
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).toBeNull()
    expect(screen.getByRole('button', { name: /add typography/i })).toBeDefined()

    // Same one-line treatment for the other four collapsible sections.
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /add border/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /add effects/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /add interaction/i })).toBeDefined()

    // The always-present Layout section (F1/F3 — Law 5) is untouched by
    // this law: its LayoutModeRow renders even though nothing is set.
    expect(document.querySelector('[data-testid="css-layout-mode-row"]')).not.toBeNull()
  })

  it('(b) a section with a base value set renders its body', () => {
    renderEditor({ storedStyles: { fontFamily: 'Inter' } })

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add typography/i })).toBeNull()
    expect(screen.getByTestId('class-style-section-dot-typography')).toBeDefined()
  })

  it('(c) a section whose ONLY value is on a non-active breakpoint still renders its body', () => {
    // The active tab's own bag is empty; the value lives on another context
    // (e.g. a tablet breakpoint override), surfaced via `crossContextStyles`.
    renderEditor({
      storedStyles: {},
      crossContextStyles: [{}, { fontFamily: 'Inter' }],
    })

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add typography/i })).toBeNull()
    // The dot reflects the cross-context value too — the section isn't just
    // open, it visibly says something is set somewhere.
    expect(screen.getByTestId('class-style-section-dot-typography')).toBeDefined()
  })

  it('a value on a non-active breakpoint does NOT force a truly empty section open', () => {
    renderEditor({
      storedStyles: {},
      crossContextStyles: [{}, {}],
    })

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).toBeNull()
    expect(screen.getByRole('button', { name: /add typography/i })).toBeDefined()
  })

  it('(d) an active style search forces bodies open, even for an otherwise-empty section', () => {
    renderEditor({ storedStyles: {}, styleQuery: 'fontFamily' })

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add typography/i })).toBeNull()
  })

  it('clicking "+" reveals the section body for this render', () => {
    renderEditor()

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /add typography/i }))
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
  })
})
