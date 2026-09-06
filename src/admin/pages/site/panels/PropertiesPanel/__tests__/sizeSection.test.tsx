/**
 * SizeSection — G2 (docs/features/inspector-disclosure.md, F30/F31).
 *
 * Covers:
 *   1. Law 3 at rest — an element with only `width` set renders exactly one
 *      row (the W/H field pair); no min/max constraint field is drawn.
 *   2. "Add minimum width…" reveals the row and writes NOTHING — the store
 *      bag handed to `onChange`/`onClearProperty` must never be touched by
 *      `onAdd` alone.
 *   3. The revealed row's "−" clears the property, hides the row again, and
 *      returns "Add minimum width…" to the field's menu.
 *   4. Hug/Fill: the field shows the mode word and keeps its own
 *      Fixed/Hug/Fill segmented row visible; Fixed hides that row.
 *   5. Switching a Hug/Fill axis back to Fixed freezes the MEASURED value
 *      (`currentStyles`), not a reset to empty.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { useState } from 'react'
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import { SizeSection } from '@site/panels/PropertiesPanel/SizeSection'
import type { CSSPropertyBag } from '@core/page-tree'

afterEach(cleanup)

interface RenderOptions {
  storedStyles?: Record<string, unknown>
  currentStyles?: Record<string, unknown>
}

/**
 * A controlled harness — `onChange`/`onClearProperty` write back into local
 * state and re-render, mirroring the real `StyleRuleComposer` round-trip.
 * Needed for the reveal/remove tests: removing a constraint only hides its
 * row once `storedStyles` itself no longer carries the property, exactly as
 * it wouldn't in the live store.
 */
function renderSizeSection({ storedStyles: initialStored = {}, currentStyles = {} }: RenderOptions = {}) {
  const calls = {
    onChange: [] as Array<[keyof CSSPropertyBag, string | number | undefined]>,
    onClearProperty: [] as Array<keyof CSSPropertyBag>,
  }

  function Harness() {
    const [storedStyles, setStoredStyles] = useState(initialStored)
    return (
      <SizeSection
        currentStyles={currentStyles}
        storedStyles={storedStyles}
        activeTab="base"
        onChange={(prop, value) => {
          calls.onChange.push([prop, value])
          setStoredStyles((prev) => ({ ...prev, [prop]: value }))
        }}
        onRemove={() => {}}
        onClearProperty={(prop) => {
          calls.onClearProperty.push(prop)
          setStoredStyles((prev) => {
            const next = { ...prev }
            delete next[prop]
            return next
          })
        }}
      />
    )
  }

  const utils = render(<Harness />)
  return { ...utils, calls }
}

async function openWidthMenu() {
  fireEvent.click(screen.getByTestId('css-size-input-width-chevron'))
  await waitFor(() => {
    expect(screen.getByRole('menu', { name: 'Width options' })).toBeDefined()
  })
}

// ---------------------------------------------------------------------------
// 1. Law 3 at rest
// ---------------------------------------------------------------------------

describe('size section — Law 3 at rest', () => {
  it('renders one row for an element with only width set', () => {
    renderSizeSection({ storedStyles: { width: '200px' } })

    expect(screen.getByRole('textbox', { name: 'Width' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Height' })).toBeTruthy()

    // None of the four constraints are drawn — no field, no remove button.
    for (const name of ['Minimum width', 'Minimum height', 'Maximum width', 'Maximum height']) {
      expect(screen.queryByRole('textbox', { name })).toBeNull()
    }
    expect(screen.queryByTestId('css-size-input-minWidth')).toBeNull()
    expect(screen.queryByTestId('css-size-input-maxWidth')).toBeNull()
    expect(screen.queryByTestId('css-size-input-minHeight')).toBeNull()
    expect(screen.queryByTestId('css-size-input-maxHeight')).toBeNull()

    // Fixed width, unset (default) height — neither axis is Hug/Fill, so
    // neither field's segmented mode row mounts.
    expect(screen.queryByTestId('css-size-mode-width')).toBeNull()
    expect(screen.queryByTestId('css-size-mode-height')).toBeNull()
  })

  it('reveals a constraint automatically once it already has a value', () => {
    renderSizeSection({ storedStyles: { width: '200px', minWidth: '80px' } })

    expect(screen.getByTestId('css-size-input-minWidth')).toBeTruthy()
    expect(screen.queryByTestId('css-size-input-maxWidth')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2 + 3. Add reveals without writing; remove clears and re-hides
// ---------------------------------------------------------------------------

describe('size section — add / remove a constraint', () => {
  it('"Add minimum width…" reveals the row and writes nothing to the store', async () => {
    const { calls } = renderSizeSection({ storedStyles: { width: '200px' } })

    await openWidthMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add minimum width…' }))

    // Revealed — the row now exists, unset.
    expect(screen.getByTestId('css-size-input-minWidth')).toBeTruthy()
    const minWidthInput = screen.getByRole('textbox', { name: 'Minimum width' }) as HTMLInputElement
    expect(minWidthInput.value).toBe('')

    // NOT written — `onAdd` reveals only, never writes CSS (the panel's own
    // "one keystroke replaced an actions array" bug this rule exists for).
    expect(calls.onChange).toEqual([])
    expect(calls.onClearProperty).toEqual([])
  })

  it('the revealed "−" clears the property, hides the row, and restores the menu item', async () => {
    const { calls } = renderSizeSection({ storedStyles: { width: '200px', minWidth: '80px' } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove minimum width' }))

    expect(calls.onClearProperty).toEqual(['minWidth'])
    expect(screen.queryByTestId('css-size-input-minWidth')).toBeNull()

    // The menu item is offered again.
    await openWidthMenu()
    expect(screen.getByRole('menuitem', { name: 'Add minimum width…' })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 4. Hug / Fill legibility, Fixed hides the segmented row
// ---------------------------------------------------------------------------

describe('size section — sizing mode', () => {
  it('Hug shows the mode word and keeps the segmented row visible', () => {
    renderSizeSection({ storedStyles: { height: 'fit-content' } })

    const heightInput = screen.getByRole('textbox', { name: 'Height' }) as HTMLInputElement
    expect(heightInput.value).toBe('Hug')

    const modeRow = screen.getByTestId('css-size-mode-height')
    expect(within(modeRow).getByRole('button', { name: 'Hug' })).toBeTruthy()
  })

  it('Fill shows the mode word and keeps the segmented row visible', () => {
    renderSizeSection({ storedStyles: { width: '100%' } })

    const widthInput = screen.getByRole('textbox', { name: 'Width' }) as HTMLInputElement
    expect(widthInput.value).toBe('Fill')
    expect(screen.getByTestId('css-size-mode-width')).toBeTruthy()
  })

  it('Fixed shows a number and hides the segmented row', () => {
    renderSizeSection({ storedStyles: { width: '200px' } })

    const widthInput = screen.getByRole('textbox', { name: 'Width' }) as HTMLInputElement
    expect(widthInput.value).toBe('200px')
    expect(screen.queryByTestId('css-size-mode-width')).toBeNull()
  })

  it('switching an unset axis to Fixed freezes the measured value from currentStyles', () => {
    const { calls } = renderSizeSection({
      storedStyles: { height: 'fit-content' },
      currentStyles: { height: '325px' },
    })

    const modeRow = screen.getByTestId('css-size-mode-height')
    fireEvent.click(within(modeRow).getByRole('button', { name: 'Fixed' }))

    expect(calls.onChange).toEqual([['height', '325px']])
  })
})
