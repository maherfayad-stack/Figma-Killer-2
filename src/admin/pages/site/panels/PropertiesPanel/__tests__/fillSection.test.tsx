/**
 * FillSection — G6 / G6.5 (docs/features/inspector-disclosure.md).
 *
 * Renders `FillSection`/`FillSectionActions` directly rather than through
 * `StyleSectionsEditor`, which keeps the test to this section's own contract.
 *
 * Covers:
 *   1. Law 1 — zero set fill properties renders nothing.
 *   2. Text fill (G9's relocation of `color` into Fill).
 *   3. Background LAYERS (G6.5): one row per `background-image` layer, in CSS
 *      paint order, add / remove / reorder, and the per-layer satellites in
 *      each row's popover.
 *   4. Honest refusal: a layer list that cannot round-trip renders as one raw
 *      row, and a satellite that cannot be split per layer gets a raw field.
 *   5. Solid fill is pinned BELOW the layers — that is where CSS paints it.
 *   6. Content fit (`objectFit`/`objectPosition`) as its own row.
 *   7. The `background` shorthand escape hatch.
 *   8. `FillSectionActions`.
 *   9. `visibleProperties` (style-search) filtering.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { FillSection, FillSectionActions } from '../FillSection'

afterEach(cleanup)

function noop() {}

const ALL_FILL_PROPS = [
  'color',
  'backgroundColor',
  'background',
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundAttachment',
  'backgroundOrigin',
  'backgroundClip',
  'backgroundBlendMode',
  'objectFit',
  'objectPosition',
] as const

type FillProps = ComponentProps<typeof FillSection>

const GRADIENT = 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)'
const GRADIENT_B = 'radial-gradient(circle, #00ff00 0%, #ffffff 100%)'

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

/** Collapses the one-property-at-a-time `onChange` calls into a final patch. */
function patchFrom(onChange: ReturnType<typeof mock>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [property, value] of onChange.mock.calls as Array<[string, unknown]>) patch[property] = value
  return patch
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

  it('treats `background-image: none` as no layers at all', () => {
    renderFill({ storedStyles: { backgroundImage: 'none' } })
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Text fill entry (G9's completion — a text node's colour IS its fill)
// ---------------------------------------------------------------------------

describe('FillSection — text fill entry', () => {
  it('shows a Text row with the colour as its summary when color is set', () => {
    renderFill({ storedStyles: { color: '#112233' } })
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('#112233')
    expect(within(row).getByRole('button', { name: 'Remove Text' })).toBeTruthy()
  })

  it('edits through its own popover and writes color', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { color: '#112233' }, onChange })

    fireEvent.click(screen.getByText('#112233'))
    const popover = screen.getByRole('dialog', { name: 'Text colour' })
    const input = within(popover).getByRole('textbox', { name: 'Text colour' })
    fireEvent.change(input, { target: { value: '#445566' } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledWith('color', '#445566')
  })

  it('is hidden by the style search when `color` is filtered out', () => {
    renderFill({
      storedStyles: { color: '#112233' },
      visibleProperties: ['backgroundColor'] as unknown as FillProps['visibleProperties'],
    })
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. Background layers
// ---------------------------------------------------------------------------

describe('FillSection — background layers', () => {
  it('draws one row per comma-separated layer, first row = topmost paint', () => {
    renderFill({ storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` } })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Linear gradient')
    expect(rows[1]!.textContent).toContain('Radial gradient')
  })

  it('does not number a single layer — there is no stack to number', () => {
    renderFill({ storedStyles: { backgroundImage: GRADIENT } })
    expect(within(screen.getByRole('listitem')).getByRole('button', { name: 'Remove Linear gradient fill' })).toBeTruthy()
  })

  it('summarises a url() layer by its path and a gradient by its stop count', () => {
    renderFill({ storedStyles: { backgroundImage: "url('/hero.png'), " + GRADIENT } })
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]!.textContent).toContain('/hero.png')
    expect(rows[1]!.textContent).toContain('2 stops')
  })

  it('removing one layer rewrites the list without it, satellites in step', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({
      storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}`, backgroundSize: 'cover, contain' },
      onChange,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Linear gradient fill 1' }))

    const patch = patchFrom(onChange)
    expect(patch.backgroundImage).toBe(GRADIENT_B)
    expect(patch.backgroundSize).toBe('contain')
  })

  it('removing the last layer clears every per-layer satellite too', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: GRADIENT, backgroundSize: 'cover' }, onChange })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Linear gradient fill' }))

    const patch = patchFrom(onChange)
    expect(patch.backgroundImage).toBeUndefined()
    expect(patch.backgroundSize).toBeUndefined()
  })

  it('reorders with Alt+ArrowDown — layer order IS paint order', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` }, onChange })

    fireEvent.keyDown(screen.getAllByRole('listitem')[0]!, { key: 'ArrowDown', altKey: true })
    expect(patchFrom(onChange).backgroundImage).toBe(`${GRADIENT_B}, ${GRADIENT}`)
  })

  it('a drag that leaves the layer block is a no-op', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    // Text row first, then one layer: Alt+ArrowUp on the layer would swap it
    // above `color`, which is a different property entirely.
    renderFill({ storedStyles: { color: '#fff', backgroundImage: `${GRADIENT}, ${GRADIENT_B}` }, onChange })

    fireEvent.keyDown(screen.getAllByRole('listitem')[1]!, { key: 'ArrowUp', altKey: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('edits one layer without touching the others', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` }, onChange })

    fireEvent.click(screen.getByText('Radial gradient'))
    const popover = screen.getByRole('dialog', { name: 'Radial gradient fill 2' })
    const stopInput = within(popover).getByRole('textbox', { name: 'Stop 1 colour' })
    fireEvent.change(stopInput, { target: { value: '#123456' } })
    fireEvent.blur(stopInput)

    const written = String(patchFrom(onChange).backgroundImage)
    expect(written.startsWith(GRADIENT)).toBe(true)
    expect(written).toContain('#123456')
  })
})

// ---------------------------------------------------------------------------
// 3b. Per-layer satellites, inside the layer's own popover
// ---------------------------------------------------------------------------

describe('FillSection — per-layer satellites', () => {
  it('writes one value per layer, leaving the others at the CSS initial', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` }, onChange })

    fireEvent.click(screen.getByText('Radial gradient'))
    const popover = screen.getByRole('dialog', { name: 'Radial gradient fill 2' })
    const size = within(popover).getByRole('textbox', { name: 'Size' })
    fireEvent.change(size, { target: { value: 'cover' } })
    fireEvent.blur(size)

    expect(patchFrom(onChange).backgroundSize).toBe('auto, cover')
  })

  it('writes ONLY the declarations that changed — one undo entry, not eight', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` }, onChange })

    fireEvent.click(screen.getByText('Radial gradient'))
    const popover = screen.getByRole('dialog', { name: 'Radial gradient fill 2' })
    const size = within(popover).getByRole('textbox', { name: 'Size' })
    fireEvent.change(size, { target: { value: 'cover' } })
    fireEvent.blur(size)

    expect(onChange.mock.calls.map((call) => call[0])).toEqual(['backgroundSize'])
  })

  it('says so when a value is shared by CSS repetition, before the edit splits it', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    // One declared size, two layers — CSS repeats it, so it is not layer 2's own.
    renderFill({ storedStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}`, backgroundSize: 'cover' }, onChange })

    fireEvent.click(screen.getByText('Radial gradient'))
    const popover = screen.getByRole('dialog', { name: 'Radial gradient fill 2' })
    const size = within(popover).getByRole('textbox', { name: 'Size (all layers)' })
    fireEvent.change(size, { target: { value: 'contain' } })
    fireEvent.blur(size)

    expect(patchFrom(onChange).backgroundSize).toBe('cover, contain')
  })

  it('shows the per-layer blend mode as a select', () => {
    renderFill({ storedStyles: { backgroundImage: GRADIENT, backgroundBlendMode: 'multiply' } })
    fireEvent.click(screen.getByText('Linear gradient'))
    const popover = screen.getByRole('dialog', { name: 'Linear gradient fill' })
    expect((within(popover).getByRole('combobox', { name: 'Blend' }) as HTMLSelectElement).value).toBe('multiply')
  })

  it('falls back to a raw whole-property field when a satellite cannot be split per layer', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    // Two size values but only one layer — CSS ignores the extra, and editing
    // per layer would silently delete it.
    renderFill({ storedStyles: { backgroundImage: GRADIENT, backgroundSize: 'cover, contain' }, onChange })

    fireEvent.click(screen.getByText('Linear gradient'))
    const popover = screen.getByRole('dialog', { name: 'Linear gradient fill' })
    expect(within(popover).queryByRole('textbox', { name: 'Size' })).toBeNull()

    const raw = within(popover).getByRole('textbox', { name: 'Size, raw CSS' })
    expect((raw as HTMLInputElement).value).toBe('cover, contain')
    fireEvent.change(raw, { target: { value: 'cover' } })
    expect(onChange).toHaveBeenCalledWith('backgroundSize', 'cover')
  })
})

// ---------------------------------------------------------------------------
// 4. Honest refusal of the layer list itself
// ---------------------------------------------------------------------------

describe('FillSection — refused layer list', () => {
  it('renders one raw row, never a guessed split, for a top-level var()', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: 'var(--page-bg)' }, onChange })

    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Custom (raw CSS)')

    fireEvent.click(screen.getByText('Custom (raw CSS)'))
    const popover = screen.getByRole('dialog', { name: 'Background image (raw CSS)' })
    expect(popover.textContent).toContain('var()')

    const raw = within(popover).getByRole('textbox', { name: 'background-image, raw CSS' })
    fireEvent.change(raw, { target: { value: GRADIENT } })
    expect(onChange).toHaveBeenCalledWith('backgroundImage', GRADIENT)
  })

  it('still shows satellites that have no layer row to live in', () => {
    renderFill({ storedStyles: { backgroundSize: 'cover' } })
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Background sizing')
    expect(row.textContent).toContain('No image layer')
  })

  it('removing that row clears only the satellites, never the image', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { backgroundImage: 'var(--page-bg)', backgroundSize: 'cover' }, onChange })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Background sizing' }))
    const patch = patchFrom(onChange)
    expect(patch.backgroundSize).toBeUndefined()
    expect('backgroundImage' in patch).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Solid fill is the BOTTOM-most paint
// ---------------------------------------------------------------------------

describe('FillSection — solid fill entry', () => {
  it('sits BELOW the image layers, because that is where CSS paints it', () => {
    renderFill({ storedStyles: { backgroundColor: '#ff0000', backgroundImage: GRADIENT } })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Linear gradient')
    expect(rows[1]!.textContent).toContain('#ff0000')
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
// 6. Content fit — the element's own replaced content
// ---------------------------------------------------------------------------

describe('FillSection — content fit entry', () => {
  it('surfaces a set objectFit as its own row, not as part of a background layer', () => {
    renderFill({ storedStyles: { objectFit: 'cover' } })
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Content fit')

    fireEvent.click(screen.getByText('Content fit'))
    const popover = screen.getByRole('dialog', { name: 'Content fit' })
    expect(within(popover).getByTestId('css-property-row-objectFit')).toBeTruthy()
    expect(within(popover).queryByRole('group', { name: /image fill type/i })).toBeNull()
  })

  it('"remove" clears both content-fit properties', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    renderFill({ storedStyles: { objectFit: 'cover', objectPosition: 'top' }, onChange })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Content fit' }))
    const patch = patchFrom(onChange)
    expect(patch.objectFit).toBeUndefined()
    expect(patch.objectPosition).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 7. background shorthand escape hatch
// ---------------------------------------------------------------------------

describe('FillSection — background shorthand escape hatch', () => {
  const shorthand = 'red url(hero.png) no-repeat'

  it('shows as a row only when set, and opens a raw-CSS popover', () => {
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
// 8. FillSectionActions
// ---------------------------------------------------------------------------

describe('FillSectionActions', () => {
  it('shows all three add buttons when nothing is set', () => {
    render(<FillSectionActions storedStyles={{}} onChange={noop} />)
    expect(screen.getByRole('button', { name: /add text colour/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add gradient fill/i })).toBeTruthy()
  })

  it('hides "add text colour" once color is set', () => {
    render(<FillSectionActions storedStyles={{ color: '#fff' }} onChange={noop} />)
    expect(screen.queryByRole('button', { name: /add text colour/i })).toBeNull()
  })

  it('hides "add solid color fill" once backgroundColor is set', () => {
    render(<FillSectionActions storedStyles={{ backgroundColor: '#000' }} onChange={noop} />)
    expect(screen.queryByRole('button', { name: /add solid color fill/i })).toBeNull()
  })

  it('keeps "add gradient fill" available once a layer exists — CSS stacks them', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{ backgroundImage: GRADIENT }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /add gradient fill/i }))
    expect(patchFrom(onChange).backgroundImage).toBe(
      `linear-gradient(180deg, #000000 0%, #ffffff 100%), ${GRADIENT}`,
    )
  })

  it('"add gradient fill" writes a parseable default gradient on an empty element', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add gradient fill/i }))
    expect(patchFrom(onChange).backgroundImage).toBe('linear-gradient(180deg, #000000 0%, #ffffff 100%)')
  })

  it('disables "add gradient fill" with a reason when the layer list was refused', () => {
    render(<FillSectionActions storedStyles={{ backgroundImage: 'var(--layers)' }} onChange={noop} />)
    const button = screen.getByRole('button', { name: /add gradient fill/i })
    expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  it('"add text colour" writes a concrete colour, not a no-op currentColor', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add text colour/i }))
    expect(onChange).toHaveBeenCalledWith('color', '#000000')
  })

  it('"add solid color fill" writes an opaque default colour', () => {
    const onChange = mock((_p: string, _v: unknown) => {})
    render(<FillSectionActions storedStyles={{}} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /add solid color fill/i }))
    expect(onChange).toHaveBeenCalledWith('backgroundColor', '#000000')
  })
})

// ---------------------------------------------------------------------------
// 9. visibleProperties (style search) filtering
// ---------------------------------------------------------------------------

describe('FillSection — visibleProperties filtering', () => {
  it('hides an entry whose properties are all filtered out of visibleProperties', () => {
    renderFill({
      storedStyles: { backgroundColor: '#ff0000', backgroundImage: GRADIENT },
      visibleProperties: ['backgroundColor'] as unknown as FillProps['visibleProperties'],
    })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('#ff0000')
  })
})
