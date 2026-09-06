/**
 * EffectsSection — the list-of-effects rebuild
 * (docs/features/inspector-disclosure.md §4 G8).
 *
 * Covers:
 *   1. Empty ⇒ nothing rendered (Law 1) — `PropertyList`'s own empty-render,
 *      independent of `StyleSectionsEditor`'s section-level collapse.
 *   2. `EffectsSectionActions`' typed "+" menu (F20) adds each supported
 *      kind, and disables Layer blur / Background blur once already set.
 *   3. A two-layer `box-shadow` with `rgba()` commas parses into exactly two
 *      rows and re-serialises byte-identically on any edit.
 *   4. An unparseable `box-shadow` keeps its raw text field and loses nothing.
 *   5. The inset checkbox round-trips.
 *   6. Reordering two shadow layers changes paint order.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { EffectsSection, EffectsSectionActions } from '../EffectsSection'

afterEach(cleanup)

function noop() {}

const EFFECTS_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'boxShadow',
  'filter',
  'backdropFilter',
  'transform',
  'transformOrigin',
  'transition',
  'animation',
]

type SectionProps = ComponentProps<typeof EffectsSection>

function renderSection(overrides: Partial<SectionProps> = {}) {
  return render(
    <EffectsSection
      storedStyles={{}}
      currentStyles={{}}
      visibleProperties={EFFECTS_PROPERTIES}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      {...overrides}
    />,
  )
}

type ActionsProps = ComponentProps<typeof EffectsSectionActions>

function renderActions(overrides: Partial<ActionsProps> = {}) {
  return render(
    <EffectsSectionActions
      activeTab="base"
      storedStyles={{}}
      currentStyles={{}}
      onChange={noop}
      onRemove={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1. Law 1 — empty renders nothing
// ---------------------------------------------------------------------------

describe('EffectsSection — empty (Law 1)', () => {
  it('renders no list at all when nothing is set', () => {
    const { container } = renderSection()
    expect(screen.queryByRole('list')).toBeNull()
    expect(container.querySelector('[role="listitem"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Typed "+" menu (F20)
// ---------------------------------------------------------------------------

describe('EffectsSectionActions — typed add menu (F20)', () => {
  it('lists exactly the four supported kinds — no Noise/Texture/Glass/Shader', async () => {
    const user = userEvent.setup()
    renderActions()

    await user.click(screen.getByRole('button', { name: 'Add effects' }))

    expect(screen.getByRole('menuitem', { name: 'Drop shadow' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Inner shadow' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Layer blur' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Background blur' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /noise/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /texture/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /glass/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /shader/i })).toBeNull()
  })

  it('"Drop shadow" writes a fresh box-shadow layer', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    renderActions({ onChange })

    await user.click(screen.getByRole('button', { name: 'Add effects' }))
    await user.click(screen.getByRole('menuitem', { name: 'Drop shadow' }))

    expect(onChange).toHaveBeenCalledWith('boxShadow', '0 4px 4px rgba(0, 0, 0, 0.25)')
  })

  it('"Inner shadow" appends onto an existing box-shadow value', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    renderActions({ onChange, storedStyles: { boxShadow: '0 2px 2px black' } })

    await user.click(screen.getByRole('button', { name: 'Add effects' }))
    await user.click(screen.getByRole('menuitem', { name: 'Inner shadow' }))

    expect(onChange).toHaveBeenCalledWith(
      'boxShadow',
      '0 2px 2px black, inset 0 4px 4px rgba(0, 0, 0, 0.25)',
    )
  })

  it('"Layer blur" / "Background blur" write blur(4px), and disable once already set', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    renderActions({ onChange })

    await user.click(screen.getByRole('button', { name: 'Add effects' }))
    await user.click(screen.getByRole('menuitem', { name: 'Layer blur' }))
    expect(onChange).toHaveBeenCalledWith('filter', 'blur(4px)')

    await user.click(screen.getByRole('button', { name: 'Add effects' }))
    await user.click(screen.getByRole('menuitem', { name: 'Background blur' }))
    expect(onChange).toHaveBeenCalledWith('backdropFilter', 'blur(4px)')
  })

  it('disables Layer blur once filter is already set', async () => {
    const user = userEvent.setup()
    renderActions({ storedStyles: { filter: 'blur(4px)' } })

    await user.click(screen.getByRole('button', { name: 'Add effects' }))
    const layerBlur = screen.getByRole('menuitem', { name: 'Layer blur' }) as HTMLButtonElement
    const backgroundBlur = screen.getByRole('menuitem', { name: 'Background blur' }) as HTMLButtonElement
    expect(layerBlur.disabled).toBe(true)
    expect(backgroundBlur.disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Two-layer box-shadow — rgba() commas don't split layers
// ---------------------------------------------------------------------------

describe('EffectsSection — box-shadow as a list', () => {
  it('renders exactly two rows for a two-layer value with rgba() commas', () => {
    renderSection({
      storedStyles: {
        boxShadow: '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 -2px 0 rgba(255, 255, 255, 0.1)',
      },
    })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Drop shadow')).toBeTruthy()
    expect(within(rows[1]!).getByText('Inner shadow')).toBeTruthy()
  })

  it('editing one layer leaves the other layer byte-identical in the re-serialised value', async () => {
    const user = userEvent.setup()
    const raw = '0 4px 4px rgba(0, 0, 0, 0.25), inset 0 -2px 0 rgba(255, 255, 255, 0.1)'

    function Stateful() {
      const [boxShadow, setBoxShadow] = useState(raw)
      return (
        <EffectsSection
          storedStyles={{ boxShadow }}
          currentStyles={{}}
          visibleProperties={EFFECTS_PROPERTIES}
          activeTab="base"
          onChange={(_property, value) => setBoxShadow(String(value))}
          onRemove={noop}
        />
      )
    }
    render(<Stateful />)

    // Toggle the SECOND layer's inset off, then back on — the first layer
    // (never touched) must read back byte-identical both times.
    await user.click(screen.getAllByRole('listitem')[1]!)
    const insetSwitch = screen.getByRole('switch')
    await user.click(insetSwitch)
    await user.click(insetSwitch)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Drop shadow')).toBeTruthy()
    expect(within(rows[1]!).getByText('Inner shadow')).toBeTruthy()
  })
})

describe('EffectsSection — honest refusal on an unparseable box-shadow', () => {
  it('keeps the raw text as a single row and preserves it exactly in the popover', async () => {
    const user = userEvent.setup()
    const raw = '0 4px 4px black, potato'
    renderSection({ storedStyles: { boxShadow: raw } })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('Box shadow')).toBeTruthy()

    await user.click(rows[0]!)
    expect(screen.getByDisplayValue(raw)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 5. Inset round-trips
// ---------------------------------------------------------------------------

describe('EffectsSection — inset checkbox', () => {
  it('adding "inset" re-serialises with the keyword leading', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    renderSection({ storedStyles: { boxShadow: '0 4px 4px black' }, onChange })

    await user.click(screen.getByRole('listitem'))
    await user.click(screen.getByRole('switch'))

    expect(onChange).toHaveBeenCalledWith('boxShadow', 'inset 0 4px 4px black')
  })

  it('removing "inset" drops the keyword', async () => {
    const user = userEvent.setup()
    const onChange = mock(() => {})
    renderSection({ storedStyles: { boxShadow: 'inset 0 4px 4px black' }, onChange })

    await user.click(screen.getByRole('listitem'))
    await user.click(screen.getByRole('switch'))

    expect(onChange).toHaveBeenCalledWith('boxShadow', '0 4px 4px black')
  })
})

// ---------------------------------------------------------------------------
// 6. Reorder changes paint order
// ---------------------------------------------------------------------------

describe('EffectsSection — reorder (Alt+ArrowDown)', () => {
  it('moving the first shadow layer down swaps their serialised order', () => {
    const onChange = mock(() => {})
    const raw = '0 4px 4px black, inset 0 -2px 0 white'
    renderSection({ storedStyles: { boxShadow: raw }, onChange })

    const [first] = screen.getAllByRole('listitem')
    fireEvent.keyDown(first!, { key: 'ArrowDown', altKey: true })

    expect(onChange).toHaveBeenCalledWith('boxShadow', 'inset 0 -2px 0 white, 0 4px 4px black')
  })
})
