/**
 * DeviceScrollbarInjector — hides scrollbars inside the live iframe, but only
 * while a device mockup is drawn.
 *
 * The two properties worth gating are the ones a future change could silently
 * break: that switching back to desktop REMOVES the rule (rather than leaving
 * an inert element, or worse, leaving the rule applied so desktop live mode
 * quietly loses its scrollbar too), and that the rule hides the scrollbar
 * without disabling scrolling — `overflow: hidden` would also remove the
 * scrollbar, by making a tall page unreachable.
 */
import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import { DeviceScrollbarInjector } from '@site/canvas/DeviceScrollbarInjector'

const STYLE_ID = 'studio-device-scrollbars'

function styleIn(doc: Document): HTMLStyleElement | null {
  return doc.head.querySelector<HTMLStyleElement>(`#${STYLE_ID}`)
}

describe('DeviceScrollbarInjector', () => {
  it('injects the rule while a device is drawn', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    render(<DeviceScrollbarInjector targetDocument={doc} hidden />)
    expect(styleIn(doc)).not.toBeNull()
  })

  it('injects nothing for desktop and fluid live mode', () => {
    // There the scrollbar IS what a visitor sees, so it must stay.
    const doc = document.implementation.createHTMLDocument('frame')
    render(<DeviceScrollbarInjector targetDocument={doc} hidden={false} />)
    expect(styleIn(doc)).toBeNull()
  })

  it('removes the rule when the author switches away from a device', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    const view = render(<DeviceScrollbarInjector targetDocument={doc} hidden />)
    expect(styleIn(doc)).not.toBeNull()
    view.rerender(<DeviceScrollbarInjector targetDocument={doc} hidden={false} />)
    // Removed, not emptied — the document is left as if no device had been
    // drawn at all.
    expect(styleIn(doc)).toBeNull()
  })

  it('hides the scrollbar without disabling scrolling', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    render(<DeviceScrollbarInjector targetDocument={doc} hidden />)
    const css = styleIn(doc)?.textContent ?? ''
    expect(css).toContain('scrollbar-width: none')
    expect(css).toContain('::-webkit-scrollbar')
    // `overflow: hidden` would remove the scrollbar by making a tall page
    // unreachable, which is a different and much worse thing.
    expect(css).not.toContain('overflow')
  })

  it('does not fall over before the iframe document exists', () => {
    expect(() => render(<DeviceScrollbarInjector targetDocument={null} hidden />)).not.toThrow()
  })
})
