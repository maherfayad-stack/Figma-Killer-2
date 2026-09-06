/**
 * FillSection — G6 (STUDIO-INSPECTOR-DISCLOSURE-PLAN.md).
 *
 * Renders `FillSection`/`FillSectionActions` directly rather than through
 * `StyleSectionsEditor` (which still dispatches to the OLD `background`
 * section id/title until the registry rename lands — see this section's
 * STATE.md handoff). Direct rendering also sidesteps
 * `StyleSectionsEditor.tsx`'s current, unrelated `BorderControl` import
 * break from a concurrent session's in-flight G7 work.
 *
 * Covers:
 *   1. Law 1 — zero set fill properties renders nothing.
 *   2. Solid fill entry: appears only when `backgroundColor` is set, edits
 *      through a popover, "remove" clears it.
 *   3. Image fill entry: gradient / URL / object-fit-only / unparseable-
 *      refused summaries, and each popover's editing behaviour.
 *   4. Removing the image entry clears backgroundImage AND its five
 *      satellite properties, so the entry actually disappears.
 *   5. The `background` shorthand escape hatch — read-only row, honestly
 *      editable via its own raw-CSS popover.
 *   6. `FillSectionActions` — which "add" buttons show/hide as each CSS
 *      channel fills up.
 *   7. `visibleProperties` (style-search) filtering.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { FillSection, FillSectionActions } from '../FillSection'

afterEach(cleanup)

function noop() {}

const ALL_FILL_PROPS = [
  'backgroundColor',
  'background',
  'backgroundImage',
  'backgroundSize',
  'backgroundRepeat',
  'backgroundPosition',
  'objectFit',
  'objectPosition',
] as const

type FillProps = ComponentProps<typeof FillSection>

function renderFill(overrides: Partial<FillProps> = {}) {
  return render(
    <FillSection
      storedStyles={{}}
      currentStyles={{}}
      visibleProperties={ALL_FILL_PROPS as unknown as FillProps['visibleProperties']}
      activeTab="base"
      onChange={noop}
      onRemove={noop}
      {...overrides}
    />,
  )
}

// ---------------------------------------------------------------------------
// 1. Law 1
// ---------------------------------------------------------------------------

describe('FillSection — Law 1', () => {
  it('renders nothing when no fill property is set', () => {
    const { container } = renderFill()
    expect(screen.queryByRole('list', { name: 'Fill' })).toBeNull()
    expect(container.querySelector('[class*="fillSection"]')?.children.length ?? 0).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Solid fill entry
// ---------------------------------------------------------------------------

describe('FillSection — solid fill entry', () => {
  it('shows a row with the colour as its summary when backgroundColor is set', () => {
    renderFill({ storedStyles: { backgroundColor: '#ff0000' } })
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('#ff0000')
  })

  it('opens a colour popover on activation and writes through onChange', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundColor: '#ff0000' }, onChange })

    fireEvent.click(screen.getByText('#ff0000'))
    const popover = screen.getByRole('dialog', { name: 'Solid fill' })
    const input = within(popover).getByRole('textbox', { name: 'Solid fill colour' })
    fireEvent.change(input, { target: { value: '#00ff00' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledWith('backgroundColor', '#00ff00')
  })

  it('"remove" clears backgroundColor', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundColor: '#ff0000' }, onChange })

    fireEvent.click(screen.getByRole('button', { name: /remove solid fill/i }))
    expect(onChange).toHaveBeenCalledWith('backgroundColor', undefined)
  })
})

// ---------------------------------------------------------------------------
// 3. Image fill entry
// ---------------------------------------------------------------------------

describe('FillSection — image fill entry (gradient)', () => {
  const gradient = 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)'

  it('summarises a parseable gradient by kind and stop count', () => {
    renderFill({ storedStyles: { backgroundImage: gradient } })
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Linear gradient')
    expect(row.textContent).toContain('2 stops')
  })

  it('opens the gradient editor and edits a stop colour', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: gradient }, onChange })

    fireEvent.click(screen.getByText('Linear gradient'))
    const popover = screen.getByRole('dialog', { name: 'Image fill' })
    const stopInput = within(popover).getByRole('textbox', { name: 'Stop 1 colour' })
    fireEvent.change(stopInput, { target: { value: '#123456' } })
    fireEvent.blur(stopInput)

    const [, written] = onChange.mock.calls.at(-1) as [string, string]
    expect(written).toContain('#123456')
    expect(written).toContain('0%')
  })

  it('adding a stop appends one with the last stop’s colour', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: gradient }, onChange })

    fireEvent.click(screen.getByText('Linear gradient'))
    fireEvent.click(screen.getByRole('button', { name: /add stop/i }))

    const [, written] = onChange.mock.calls.at(-1) as [string, string]
    expect(written).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%, #0000ff)')
  })

  it('disables removing a stop once only two remain', () => {
    renderFill({ storedStyles: { backgroundImage: gradient } })
    fireEvent.click(screen.getByText('Linear gradient'))

    // `Button` converts `disabled` + `tooltip` together into `aria-disabled`
    // (native `disabled` would swallow the pointerenter the tooltip needs).
    const removeButtons = screen.getAllByRole('button', { name: /remove stop/i })
    expect(removeButtons).toHaveLength(2)
    for (const button of removeButtons) expect(button.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('FillSection — image fill entry (url)', () => {
  it('summarises a url() value by its path', () => {
    renderFill({ storedStyles: { backgroundImage: "url('/hero.png')" } })
    expect(screen.getByRole('listitem').textContent).toContain('/hero.png')
  })

  it('edits the URL through the image-mode field', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: "url('/hero.png')" }, onChange })

    fireEvent.click(screen.getByText('/hero.png'))
    const popover = screen.getByRole('dialog', { name: 'Image fill' })
    const input = within(popover).getByRole('textbox', { name: 'Image URL' })
    fireEvent.change(input, { target: { value: '/new.png' } })

    expect(onChange).toHaveBeenCalledWith('backgroundImage', "url('/new.png')")
  })
})

describe('FillSection — image fill entry (object-fit only, no backgroundImage)', () => {
  it('still surfaces an entry so a set objectFit is never invisible', () => {
    renderFill({ storedStyles: { objectFit: 'cover' } })
    expect(screen.getByRole('listitem').textContent).toContain('Object fit')
  })

  it('the popover has no mode toggle and no image field, only sizing rows', () => {
    renderFill({ storedStyles: { objectFit: 'cover' } })
    fireEvent.click(screen.getByText('Object fit'))
    const popover = screen.getByRole('dialog', { name: 'Image fill' })
    expect(within(popover).queryByRole('group', { name: /image fill type/i })).toBeNull()
    expect(within(popover).getByTestId('css-property-row-objectFit')).toBeTruthy()
  })
})

describe('FillSection — image fill entry (unparseable gradient refuses the visual editor)', () => {
  const hint = 'linear-gradient(red, 50%, blue)' // a colour hint — gradientValue.ts refuses this

  it('falls back to a raw, honestly-editable field instead of a fake structured editor', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: hint }, onChange })

    expect(screen.getByRole('listitem').textContent).toContain('Custom (raw CSS)')

    fireEvent.click(screen.getByText('Custom (raw CSS)'))
    const popover = screen.getByRole('dialog', { name: 'Image fill' })
    expect(within(popover).queryByRole('group', { name: /image fill type/i })).toBeNull()

    const rawInput = within(popover).getByRole('textbox', { name: /raw css/i })
    expect((rawInput as HTMLInputElement).value).toBe(hint)
    fireEvent.change(rawInput, { target: { value: 'linear-gradient(red, blue)' } })
    expect(onChange).toHaveBeenCalledWith('backgroundImage', 'linear-gradient(red, blue)')
  })
})

// ---------------------------------------------------------------------------
// 4. Removing the image entry clears its satellites too
// ---------------------------------------------------------------------------

describe('FillSection — removing the image entry', () => {
  it('clears backgroundImage AND every satellite property', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({
      storedStyles: {
        backgroundImage: 'linear-gradient(red, blue)',
        backgroundSize: 'cover',
        objectFit: 'contain',
      },
      onChange,
    })

    fireEvent.click(screen.getByRole('button', { name: /remove linear gradient fill/i }))

    const calledProps = onChange.mock.calls.map((call) => call[0])
    expect(calledProps).toEqual(
      expect.arrayContaining([
        'backgroundImage',
        'backgroundSize',
        'backgroundRepeat',
        'backgroundPosition',
        'objectFit',
        'objectPosition',
      ]),
    )
    for (const call of onChange.mock.calls) expect(call[1]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. background shorthand escape hatch
// ---------------------------------------------------------------------------

describe('FillSection — background shorthand escape hatch', () => {
  const shorthand = 'red url(hero.png) no-repeat'

  it('shows as a read-only row only when set', () => {
    const { rerender } = renderFill()
    expect(screen.queryByText(shorthand)).toBeNull()

    rerender(
      <FillSection
        storedStyles={{ background: shorthand }}
        currentStyles={{}}
        visibleProperties={ALL_FILL_PROPS as unknown as FillProps['visibleProperties']}
        activeTab="base"
        onChange={noop}
        onRemove={noop}
      />,
    )
    expect(screen.getByText(shorthand)).toBeTruthy()
  })

  it('opens a raw-CSS popover — not a structured editor — and still allows editing', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { background: shorthand }, onChange })

    fireEvent.click(screen.getByText(shorthand))
    const popover = screen.getByRole('dialog', { name: 'Background (raw CSS)' })
    const input = within(popover).getByRole('textbox', { name: /background, raw css/i })
    expect((input as HTMLInputElement).value).toBe(shorthand)

    fireEvent.change(input, { target: { value: 'blue' } })
    expect(onChange).toHaveBeenCalledWith('background', 'blue')
  })

  it('"remove" clears the shorthand', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { background: shorthand }, onChange })

    fireEvent.click(screen.getByRole('button', { name: /remove background shorthand/i }))
    expect(onChange).toHaveBeenCalledWith('background', undefined)
  })
})

// ---------------------------------------------------------------------------
// 6. FillSectionActions
// ---------------------------------------------------------------------------

describe('FillSectionActions', () => {
  it('shows both add buttons when nothing is set', () => {
    render(<FillSectionActions storedStyles={{}} onChange={noop} />)
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add gradient fill/i })).toBeTruthy()
  })

  it('hides "add solid color fill" once backgroundColor is set', () => {
    render(<FillSectionActions storedStyles={{ backgroundColor: '#000' }} onChange={noop} />)
    expect(screen.queryByRole('button', { name: /add solid color fill/i })).toBeNull()
    expect(screen.getByRole('button', { name: /add gradient fill/i })).toBeTruthy()
  })

  it('hides "add gradient fill" once backgroundImage is set to something other than none', () => {
    render(<FillSectionActions storedStyles={{ backgroundImage: 'url(x.png)' }} onChange={noop} />)
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /add gradient fill/i })).toBeNull()
  })

  it('treats backgroundImage: none as unset', () => {
    render(<FillSectionActions storedStyles={{ backgroundImage: 'none' }} onChange={noop} />)
    expect(screen.getByRole('button', { name: /add gradient fill/i })).toBeTruthy()
  })

  it('renders nothing once both channels are in use', () => {
    const { container } = render(
      <FillSectionActions storedStyles={{ backgroundColor: '#000', backgroundImage: 'url(x.png)' }} onChange={noop} />,
    )
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('"add solid color fill" writes an opaque default colour', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add solid color fill/i }))
    expect(onChange).toHaveBeenCalledWith('backgroundColor', '#000000')
  })

  it('"add gradient fill" writes a parseable default gradient', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add gradient fill/i }))
    expect(onChange).toHaveBeenCalledWith('backgroundImage', 'linear-gradient(180deg, #000000 0%, #ffffff 100%)')
  })
})

// ---------------------------------------------------------------------------
// 7. visibleProperties (style search) filtering
// ---------------------------------------------------------------------------

describe('FillSection — visibleProperties filtering', () => {
  it('hides an entry whose properties are all filtered out of visibleProperties', () => {
    renderFill({
      storedStyles: { backgroundColor: '#ff0000', backgroundImage: 'linear-gradient(red, blue)' },
      visibleProperties: ['backgroundColor'] as unknown as FillProps['visibleProperties'],
    })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('#ff0000')
  })
})
