/**
 * TokenizedColorField — T8/T9 (`STUDIO-FIGMA-PARITY-PLAN.md` §11).
 *
 * T8: the swatch used to be a native `<input type="color">` that wrote a raw
 * hex on one click, silently detaching the value from its token. The swatch
 * now opens the token menu; the native input is reachable only via an
 * explicit "Custom color…" row.
 *
 * T9: a WCAG contrast badge renders when a caller supplies `contrastAgainst`,
 * and does not render (rather than showing a wrong/undefined badge) when it
 * doesn't.
 */
import { afterEach, describe, expect, it } from 'bun:test'
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

describe('TokenizedColorField — swatch opens the token menu, not the OS dialog (T8)', () => {
  it('clicking the swatch opens the listbox menu rather than a native colour picker', () => {
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
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('the native colour input is visually hidden and unreachable by tab, and is the ONLY thing "Custom color…" reveals', () => {
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
    const customAction = screen.getByRole('button', { name: 'Custom color…' })
    expect(customAction).toBeTruthy()

    const nativeInput = document.querySelector('input[type="color"]') as HTMLInputElement
    expect(nativeInput).toBeTruthy()
    expect(nativeInput.tabIndex).toBe(-1)
    expect(nativeInput.getAttribute('aria-hidden')).toBe('true')
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
