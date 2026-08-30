/**
 * The Size block's density — what a 24px-tall field spends its width on.
 *
 * Before this pass the six size fields carried their names as text ("Min W",
 * "Max H") and `aspectRatio` / `boxSizing` each owned a full-width row under
 * a caption. That is eight rows of chrome for eight numbers, and it is the
 * single clearest place the panel read as a form rather than as an inspector.
 *
 * Width and height keep their letterforms — `W` and `H` are unambiguous, and
 * Figma keeps them too. Everything else is a mark, and the words survive only
 * where a screen reader can reach them.
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
  it('names every constraint field for assistive tech while showing no words', () => {
    const { container } = renderSizeSection()

    for (const name of [
      'Width',
      'Height',
      'Minimum width',
      'Minimum height',
      'Maximum width',
      'Maximum height',
    ]) {
      expect(screen.getByRole('textbox', { name })).toBeTruthy()
    }

    // The four constraint fields draw marks, not text. `W` and `H` stay —
    // a letterform IS the mark there.
    const visible = container.textContent ?? ''
    expect(visible).toContain('W')
    expect(visible).toContain('H')
    for (const gone of ['Min W', 'Min H', 'Max W', 'Max H']) {
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

  it('keeps a clear affordance on a field that has a value', () => {
    renderSizeSection({ minWidth: '320px' })

    // The mark replaced the words, not the ability to unset the property.
    expect(screen.getByRole('button', { name: 'Clear minimum width' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear maximum width' })).toBeNull()
  })
})
