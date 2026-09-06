import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Button } from '@ui/components/Button'
import { ColorPickerPopover, type ColorPickerToken } from './ColorPickerPopover'

afterEach(cleanup)

function rect(r: Partial<DOMRect>): DOMRect {
  return {
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}), ...r,
  } as DOMRect
}

/** Same technique as `InspectorPopover.test.tsx` — a generous viewport, a
 * trigger with room on every side, and a small fixed popover size. */
function stubLayout() {
  const realRect = HTMLElement.prototype.getBoundingClientRect
  const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const realInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const realRO = globalThis.ResizeObserver

  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })

  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute('role') === 'dialog') {
      return rect({ top: 0, left: 0, right: 248, bottom: 400, width: 248, height: 400 })
    }
    if ((this as HTMLElement).dataset.anchor === 'true') {
      return rect({ top: 400, bottom: 420, left: 700, right: 780, width: 80, height: 20 })
    }
    return realRect.call(this)
  }

  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

  return function restore() {
    HTMLElement.prototype.getBoundingClientRect = realRect
    globalThis.ResizeObserver = realRO
    if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
    if (realInnerWidth) Object.defineProperty(window, 'innerWidth', realInnerWidth)
  }
}

function Harness({
  value,
  onChange,
  tokens,
  appliedTokenId,
  recentColors,
  contrastAgainst,
}: {
  value: string
  onChange: (next: string) => void
  tokens?: ReadonlyArray<ColorPickerToken>
  appliedTokenId?: string
  recentColors?: ReadonlyArray<string>
  contrastAgainst?: string
}) {
  const [open, setOpen] = useState(true)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button ref={triggerRef} variant="ghost" size="xs" iconOnly aria-label="Fill colour" data-anchor="true" onClick={() => setOpen(true)} />
      {open && (
        <ColorPickerPopover
          id="fill-color"
          anchorRef={triggerRef}
          onClose={() => setOpen(false)}
          value={value}
          onChange={onChange}
          tokens={tokens}
          appliedTokenId={appliedTokenId}
          recentColors={recentColors}
          contrastAgainst={contrastAgainst}
        />
      )}
    </>
  )
}

describe('ColorPickerPopover — opens left and restores focus (via InspectorPopover)', () => {
  it('opens to the left of its trigger by default', () => {
    const restore = stubLayout()
    try {
      render(<Harness value="#3355ff" onChange={() => {}} />)
      const dialog = screen.getByRole('dialog')
      // Anchor left edge is 700; a 248px-wide popover with an 8px default
      // offset opening left should sit at 700 - 248 - 8 = 444.
      expect(dialog.style.getPropertyValue('--inspector-popover-x')).toBe('444px')
    } finally {
      restore()
    }
  })

  it('restores focus to the trigger on close', async () => {
    const restore = stubLayout()
    try {
      render(<Harness value="#3355ff" onChange={() => {}} />)
      const dialog = await screen.findByRole('dialog')
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /fill colour/i }))
      })
    } finally {
      restore()
    }
  })
})

describe('ColorPickerPopover — model round-trip', () => {
  it('shows the value in hex by default and lets typing an rgb() value round-trip on blur', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="#3355ff" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: /color value/i })
    expect(field).toHaveProperty('value', '#3355ff')

    fireEvent.change(field, { target: { value: 'rgb(10, 20, 30)' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith('#0a141e')
  })

  it('round-trips through the RGB model', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="#3355ff" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'RGB' }))
    const field = screen.getByRole('textbox', { name: /color value/i })
    expect(field).toHaveProperty('value', 'rgb(51, 85, 255)')

    fireEvent.change(field, { target: { value: 'rgb(10, 20, 30)' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith('rgb(10, 20, 30)')
  })

  it('round-trips through the HSL model', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="hsl(0, 100%, 50%)" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'HSL' }))
    const field = screen.getByRole('textbox', { name: /color value/i })
    expect(field).toHaveProperty('value', 'hsl(0, 100%, 50%)')
  })

  it('reverts to the last valid value when the typed text does not parse', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="#3355ff" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: /color value/i })
    fireEvent.change(field, { target: { value: 'not-a-color' } })
    fireEvent.blur(field)
    expect(onChange).not.toHaveBeenCalled()
    expect(field).toHaveProperty('value', '#3355ff')
  })
})

describe('ColorPickerPopover — alpha round-trips through the value field', () => {
  it('typing an alpha value commits it through onChange', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="#3355ff" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: /color value/i })
    fireEvent.change(field, { target: { value: '#3355ff80' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledTimes(1)
    const [committed] = onChange.mock.calls[0]!
    expect(committed).toMatch(/^#3355ff[0-9a-f]{2}$/)
  })
})

describe('ColorPickerPopover — the "never lie" rule', () => {
  it('preserves an unparseable value verbatim and never calls onChange just from opening', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="conic-gradient(red, blue)" onChange={onChange} />)
    expect(screen.getByText(/can't preview this value/i)).toBeTruthy()
    const field = screen.getByRole('textbox', { name: /color value/i })
    expect(field).toHaveProperty('value', 'conic-gradient(red, blue)')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits an edited raw value exactly as typed, with no reformatting', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="conic-gradient(red, blue)" onChange={onChange} />)
    const field = screen.getByRole('textbox', { name: /color value/i })
    fireEvent.change(field, { target: { value: 'conic-gradient(red, green)' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenCalledWith('conic-gradient(red, green)')
  })
})

describe('ColorPickerPopover — Tokens tab', () => {
  const tokens: ColorPickerToken[] = [
    { id: 'brand', name: '--brand-500', value: '#3355ff', meta: 'Brand / 500' },
  ]

  it('applies a var(--token) reference, not the resolved hex, when a token row is clicked', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="#3355ff" onChange={onChange} tokens={tokens} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }))
    fireEvent.click(screen.getByRole('option', { name: /--brand-500/i }))
    expect(onChange).toHaveBeenCalledWith('var(--brand-500)')
  })

  it('reads Tokens-first when a token is currently applied', () => {
    render(<Harness value="#3355ff" onChange={() => {}} tokens={tokens} appliedTokenId="brand" />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Tokens', 'Custom'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('hides the Tokens tab entirely when no tokens are supplied', () => {
    render(<Harness value="#3355ff" onChange={() => {}} />)
    expect(screen.queryByRole('tab', { name: 'Tokens' })).toBeNull()
  })
})

describe('ColorPickerPopover — "On this page" recents', () => {
  it('commits the exact recent colour string when clicked', () => {
    const onChange = mock((_next: string) => {})
    render(<Harness value="#3355ff" onChange={onChange} recentColors={['#ff0000', 'var(--brand-500)']} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply var(--brand-500)' }))
    expect(onChange).toHaveBeenCalledWith('var(--brand-500)')
  })

  it('renders nothing when no recents are supplied', () => {
    render(<Harness value="#3355ff" onChange={() => {}} />)
    expect(screen.queryByText('On this page')).toBeNull()
  })
})

describe('ColorPickerPopover — contrast readout', () => {
  it('renders no badge when contrastAgainst is omitted', () => {
    render(<Harness value="#000000" onChange={() => {}} />)
    expect(screen.queryByTitle('WCAG contrast against the resolved background')).toBeNull()
  })

  it('renders an AAA badge for black text on a white background', () => {
    render(<Harness value="#000000" onChange={() => {}} contrastAgainst="#ffffff" />)
    const badge = screen.getByTitle('WCAG contrast against the resolved background')
    expect(badge.textContent).toBe('AAA 21')
  })
})

describe('ColorPickerPopover — eyedropper feature detection', () => {
  it('is absent when window.EyeDropper does not exist', () => {
    const original = (window as unknown as { EyeDropper?: unknown }).EyeDropper
    delete (window as unknown as { EyeDropper?: unknown }).EyeDropper
    try {
      render(<Harness value="#3355ff" onChange={() => {}} />)
      expect(screen.queryByRole('button', { name: /pick a colour from the screen/i })).toBeNull()
    } finally {
      if (original !== undefined) (window as unknown as { EyeDropper?: unknown }).EyeDropper = original
    }
  })

  it('is present when window.EyeDropper exists', () => {
    class FakeEyeDropper {
      open() {
        return Promise.resolve({ sRGBHex: '#00ff00' })
      }
    }
    const win = window as unknown as { EyeDropper?: unknown }
    const original = win.EyeDropper
    win.EyeDropper = FakeEyeDropper
    try {
      render(<Harness value="#3355ff" onChange={() => {}} />)
      expect(screen.getByRole('button', { name: /pick a colour from the screen/i })).toBeTruthy()
    } finally {
      win.EyeDropper = original
    }
  })
})
