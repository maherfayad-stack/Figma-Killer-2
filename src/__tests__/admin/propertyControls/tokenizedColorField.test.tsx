/**
 * TokenizedColorField — T8/T9 (`STUDIO-FIGMA-PARITY-PLAN.md` §11) and G6.2
 * (`STUDIO-INSPECTOR-DISCLOSURE-PLAN.md`).
 *
 * T8 (superseded by G6.2): the swatch used to be a native
 * `<input type="color">` that wrote a raw hex on one click, silently
 * detaching the value from its token, then a token listbox with a "Custom
 * color…" escape hatch back to that same native dialog. The swatch now opens
 * `ColorPickerPopover` directly — a real HSV/alpha picker with its own
 * Tokens tab — so there is no native colour input anywhere in this
 * component's DOM any more (`ColorPickerPopover.test.tsx` covers the
 * picker's own behaviour; this file covers only the swatch's wiring to it).
 *
 * T9: a WCAG contrast badge renders when a caller supplies `contrastAgainst`,
 * and does not render (rather than showing a wrong/undefined badge) when it
 * doesn't.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { TokenizedColorField } from '@site/property-controls/TokenizedColorField'
import type { FrameworkColorToken } from '@core/framework-schema'

function brandToken(): FrameworkColorToken {
  return {
    id: 'tok-brand',
    category: 'color',
    slug: 'brand',
    lightValue: '#0c9ab0',
    darkValue: '',
    darkModeEnabled: false,
    generateUtilities: { text: true, background: true, border: true, fill: false },
    generateTransparent: false,
    generateShades: { enabled: false, count: 0 },
    generateTints: { enabled: false, count: 0 },
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function setFrameworkColors(tokens: FrameworkColorToken[]) {
  const current = useEditorStore.getState().site
  useEditorStore.setState({
    site: {
      ...(current ?? ({} as NonNullable<typeof current>)),
      settings: {
        ...(current?.settings ?? { shortcuts: {} }),
        framework: { colors: { tokens } },
      },
    },
  } as Parameters<typeof useEditorStore.setState>[0])
}

afterEach(() => {
  cleanup()
  useEditorStore.setState({ site: undefined } as Parameters<typeof useEditorStore.setState>[0])
})

function noop() {}

describe('TokenizedColorField — swatch opens the real colour picker, not the OS dialog (G6.2)', () => {
  it('clicking the swatch opens ColorPickerPopover as a dialog, not a native colour picker', () => {
    setFrameworkColors([brandToken()])
    render(
      <TokenizedColorField
        value="var(--brand)"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={noop}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Text colour swatch' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Text colour' })).toBeTruthy()
  })

  it('reads Tokens-first and highlights the applied token when the field currently holds a var() reference', () => {
    setFrameworkColors([brandToken()])
    render(
      <TokenizedColorField
        value="var(--brand)"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={noop}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Text colour swatch' }))
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Tokens', 'Custom'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: /--brand/i })).toBeTruthy()
  })

  it('has no native <input type="color"> and no "Custom color…" escape hatch anywhere in its DOM', () => {
    setFrameworkColors([brandToken()])
    render(
      <TokenizedColorField
        value="var(--brand)"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={noop}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Text colour swatch' }))
    expect(document.querySelector('input[type="color"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Custom color…' })).toBeNull()
  })

  it('picking a token from the popover calls onTokenSelect with a var() reference', () => {
    setFrameworkColors([brandToken()])
    const onTokenSelect = mock((_value: string) => {})
    render(
      <TokenizedColorField
        value="#000000"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={onTokenSelect}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Text colour swatch' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }))
    fireEvent.click(screen.getByRole('option', { name: /--brand/i }))
    expect(onTokenSelect).toHaveBeenCalledWith('var(--brand)')
  })
})

describe('TokenizedColorField — WCAG contrast badge (T9)', () => {
  it('renders no badge when contrastAgainst is not supplied', () => {
    setFrameworkColors([brandToken()])
    render(
      <TokenizedColorField
        value="#0c9ab0"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={noop}
      />,
    )
    expect(screen.queryByTitle('WCAG contrast against the resolved background')).toBeNull()
  })

  it('renders an AAA badge for black text on white (21:1) when contrastAgainst is supplied', () => {
    setFrameworkColors([brandToken()])
    render(
      <TokenizedColorField
        value="#000000"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        contrastAgainst="#ffffff"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={noop}
      />,
    )
    const badge = screen.getByTitle('WCAG contrast against the resolved background')
    expect(badge.textContent).toBe('AAA 21')
  })

  it('renders the bare ratio, not a false AA/AAA label, when contrast fails', () => {
    setFrameworkColors([brandToken()])
    render(
      <TokenizedColorField
        value="#777777"
        inputLabel="Text colour"
        swatchLabel="Text colour swatch"
        contrastAgainst="#888888"
        onTextChange={noop}
        onTextBlur={noop}
        onSwatchChange={noop}
        onTokenSelect={noop}
      />,
    )
    const badge = screen.getByTitle('WCAG contrast against the resolved background')
    expect(badge.textContent).toMatch(/^\d+(\.\d+)?:1$/)
  })
})
