/**
 * The Size block's density — what a 24px-tall field spends its width on.
 *
 * Before the WS-6 pass the six size fields carried their names as text
 * ("Min W", "Max H") and were drawn unconditionally, and `aspectRatio` /
 * `boxSizing` each owned a full-width row under a caption. G2
 * (`STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`, Law 3) went further for the
 * constraint fields: `minWidth`/`maxWidth`/`minHeight`/`maxHeight` are no
 * longer fields at all until asked for — see `sizeSection.test.tsx` for that
 * behaviour. This file keeps the still-true claims: `W`/`H` keep their
 * letterforms, and `aspectRatio`/`boxSizing` stay paired into one
 * uncaptioned row.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { SizeSection } from '@site/panels/PropertiesPanel/SizeSection'

afterEach(cleanup)

const noop = () => {}

function renderSizeSection(stored: Record<string, unknown> = {}) {
  return render(
    <SizeSection
      currentStyles={{}}
      storedStyles={stored}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      onClearProperty={noop}
    />,
  )
}

describe('size section density', () => {
  it('names width and height for assistive tech while showing only a letterform', () => {
    const { container } = renderSizeSection()

    for (const name of ['Width', 'Height']) {
      expect(screen.getByRole('textbox', { name })).toBeTruthy()
    }

    const visible = container.textContent ?? ''
    expect(visible).toContain('W')
    expect(visible).toContain('H')

    // Law 3: an unset constraint is not a field, it's a menu item — none of
    // the four render (nor their withdrawn "Min W" / "Max H" text labels).
    for (const gone of ['Minimum width', 'Minimum height', 'Maximum width', 'Maximum height', 'Min W', 'Min H', 'Max W', 'Max H']) {
      expect(screen.queryByRole('textbox', { name: gone })).toBeNull()
      expect(visible).not.toContain(gone)
    }
  })

  it('pairs aspect-ratio and box-sizing into one uncaptioned row', () => {
    const { container } = renderSizeSection()

    // Both controls are still there and still named…
    expect(screen.getByRole('textbox', { name: 'Aspect ratio' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Box sizing' })).toBeTruthy()

    // …but neither spends a line on printing that name. This is what turned
    // two full-width captioned rows into one paired row.
    expect(container.textContent).not.toContain('Aspect ratio')
    expect(container.textContent).not.toContain('Box sizing')
  })

  it('reveals a set constraint with a remove affordance, not a clear button', () => {
    renderSizeSection({ minWidth: '320px' })

    // The set constraint renders (a property already carrying a value is
    // revealed automatically) with `RevealedField`'s "Remove …" affordance.
    expect(screen.getByRole('button', { name: 'Remove minimum width' })).toBeTruthy()
    // The unset sibling constraints stay menu items, not rows.
    expect(screen.queryByRole('button', { name: 'Remove maximum width' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Maximum width' })).toBeNull()
  })
})
