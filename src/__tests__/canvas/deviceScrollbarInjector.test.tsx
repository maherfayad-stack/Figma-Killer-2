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
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { DeviceScrollbarInjector } from '@site/canvas/DeviceScrollbarInjector'
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

const STYLE_ID = 'studio-device-scrollbars'

let adapters: PortalFrameAdapter[] = []

afterEach(() => {
  cleanup()
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

function makeAdapter(doc: Document): PortalFrameAdapter {
  const adapter = new PortalFrameAdapter(doc)
  adapters.push(adapter)
  return adapter
}

function styleIn(doc: Document): Element | null {
  return doc.head.querySelector(`[data-studio-overlay-id="${STYLE_ID}"]`)
}

describe('DeviceScrollbarInjector', () => {
  it('injects the rule while a device is drawn', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    const adapter = makeAdapter(doc)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <DeviceScrollbarInjector hidden />
      </CanvasFrameAdapterContext.Provider>,
    )
    expect(styleIn(doc)).not.toBeNull()
  })

  it('injects nothing for desktop and fluid live mode', () => {
    // There the scrollbar IS what a visitor sees, so it must stay.
    const doc = document.implementation.createHTMLDocument('frame')
    const adapter = makeAdapter(doc)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <DeviceScrollbarInjector hidden={false} />
      </CanvasFrameAdapterContext.Provider>,
    )
    expect(styleIn(doc)).toBeNull()
  })

  it('removes the rule when the author switches away from a device', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    const adapter = makeAdapter(doc)
    const view = render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <DeviceScrollbarInjector hidden />
      </CanvasFrameAdapterContext.Provider>,
    )
    expect(styleIn(doc)).not.toBeNull()
    view.rerender(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <DeviceScrollbarInjector hidden={false} />
      </CanvasFrameAdapterContext.Provider>,
    )
    // Removed, not emptied — the document is left as if no device had been
    // drawn at all.
    expect(styleIn(doc)).toBeNull()
  })

  it('hides the scrollbar without disabling scrolling', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    const adapter = makeAdapter(doc)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <DeviceScrollbarInjector hidden />
      </CanvasFrameAdapterContext.Provider>,
    )
    const css = styleIn(doc)?.textContent ?? ''
    expect(css).toContain('scrollbar-width: none')
    expect(css).toContain('::-webkit-scrollbar')
    // `overflow: hidden` would remove the scrollbar by making a tall page
    // unreachable, which is a different and much worse thing.
    expect(css).not.toContain('overflow')
  })

  it('does not fall over before the iframe adapter exists', () => {
    expect(() =>
      render(
        <CanvasFrameAdapterContext.Provider value={null}>
          <DeviceScrollbarInjector hidden />
        </CanvasFrameAdapterContext.Provider>,
      ),
    ).not.toThrow()
  })
})
