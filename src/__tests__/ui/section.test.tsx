/**
 * `Section` — the three header shapes (P2-H).
 *
 *   - collapsible: a real toggle button, `aria-expanded` honest both ways;
 *   - `empty`: a static header, no body;
 *   - `forceOpen`: a static header over an always-rendered body. It used to
 *     draw the toggle button and make its click a no-op, so every populated
 *     Fill/Stroke/Effects/Text/Export header was a tab stop announcing
 *     `aria-expanded="true"` for a disclosure that could never close.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Section } from '@ui/components/Section'

afterEach(cleanup)

const SECTION_CSS = readFileSync(
  join(import.meta.dir, '../../ui/components/Section/Section.module.css'),
  'utf8',
)

describe('Section — forceOpen draws no toggle', () => {
  it('renders the body with no button in the header at all', () => {
    const { container } = render(
      <Section title="Fill" forceOpen>
        <p>body</p>
      </Section>,
    )
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.getByText('Fill')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[aria-expanded]')).toBeNull()
  })

  it('keeps the header actions, the indicator and the status', () => {
    render(
      <Section
        title="Export"
        forceOpen
        indicator
        indicatorTestId="export-dot"
        status="1 ready"
        actions={<button type="button">Add export</button>}
      >
        <p>row</p>
      </Section>,
    )
    expect(screen.getByRole('button', { name: 'Add export' })).toBeTruthy()
    expect(screen.getByTestId('export-dot')).toBeTruthy()
    expect(screen.getByText('1 ready')).toBeTruthy()
    // The only button is the action — nothing announces a disclosure.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('Section — collapsible', () => {
  it('toggles its body and says so', () => {
    render(
      <Section title="Layout">
        <p>body</p>
      </Section>,
    )
    const toggle = screen.getByRole('button', { name: /Layout/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('body')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('body')).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('draws the inspector focus ring, not the browser outline (UX-26)', () => {
    const rule = SECTION_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(
      /\.sectionToggle:focus-visible\s*\{[^}]*\}/,
    )
    expect(rule?.[0]).toMatch(/outline:\s*1px solid var\(--overlay-50\);/)
    expect(rule?.[0]).toMatch(/outline-offset:\s*-1px;/)
  })
})

describe('Section — empty', () => {
  it('renders the header alone', () => {
    const { container } = render(
      <Section title="Stroke" empty actions={<button type="button">Add stroke</button>}>
        <p>body</p>
      </Section>,
    )
    expect(screen.queryByText('body')).toBeNull()
    expect(container.querySelector('[aria-expanded]')).toBeNull()
  })
})
