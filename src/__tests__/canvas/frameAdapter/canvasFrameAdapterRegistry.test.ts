/**
 * canvasFrameAdapterRegistry — module-scoped, so each test uses its own
 * throwaway iframe elements as keys rather than resetting global state
 * between tests (there is nothing TO reset except what a test itself adds).
 */
import { describe, expect, it } from 'bun:test'
import {
  listFrameAdapterRegistrations,
  listFrameAdapters,
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

function makeIframe(): HTMLIFrameElement {
  return document.createElement('iframe')
}

describe('canvasFrameAdapterRegistry', () => {
  it('lists every registered adapter, keyed by its own iframe', () => {
    const iframeA = makeIframe()
    const iframeB = makeIframe()
    const adapterA = new PortalFrameAdapter(document.implementation.createHTMLDocument('a'))
    const adapterB = new PortalFrameAdapter(document.implementation.createHTMLDocument('b'))

    registerFrameAdapter(iframeA, adapterA, 'desktop')
    registerFrameAdapter(iframeB, adapterB, 'mobile')

    const listed = listFrameAdapters()
    expect(listed.get(iframeA)).toBe(adapterA)
    expect(listed.get(iframeB)).toBe(adapterB)

    unregisterFrameAdapter(iframeA)
    unregisterFrameAdapter(iframeB)
    adapterA.dispose()
    adapterB.dispose()
  })

  it('unregister drops exactly the one entry, by iframe identity', () => {
    const iframeA = makeIframe()
    const iframeB = makeIframe()
    const adapterA = new PortalFrameAdapter(document.implementation.createHTMLDocument('a'))
    const adapterB = new PortalFrameAdapter(document.implementation.createHTMLDocument('b'))
    registerFrameAdapter(iframeA, adapterA, 'desktop')
    registerFrameAdapter(iframeB, adapterB, 'mobile')

    unregisterFrameAdapter(iframeA)

    expect(listFrameAdapters().has(iframeA)).toBe(false)
    expect(listFrameAdapters().get(iframeB)).toBe(adapterB)

    unregisterFrameAdapter(iframeB)
    adapterA.dispose()
    adapterB.dispose()
  })

  it('unregistering an iframe that was never registered is a safe no-op', () => {
    expect(() => unregisterFrameAdapter(makeIframe())).not.toThrow()
  })

  it('re-registering the SAME iframe replaces its adapter (a fresh adapter per documentMode/iframeDoc transition)', () => {
    const iframe = makeIframe()
    const first = new PortalFrameAdapter(document.implementation.createHTMLDocument('first'))
    const second = new PortalFrameAdapter(document.implementation.createHTMLDocument('second'))

    registerFrameAdapter(iframe, first, 'desktop')
    registerFrameAdapter(iframe, second, 'mobile')

    expect(listFrameAdapters().get(iframe)).toBe(second)

    unregisterFrameAdapter(iframe)
    first.dispose()
    second.dispose()
  })

  // `speed-01` — each registration carries the frame's own breakpoint id,
  // so a Class B caller (`optimisticStructuralBroadcast.ts`) can target a
  // breakpoint-context style preview at only the frame(s) rendering it.
  describe('listFrameAdapterRegistrations — breakpoint ids', () => {
    it('carries each registration\'s breakpointId alongside its adapter', () => {
      const iframeA = makeIframe()
      const iframeB = makeIframe()
      const adapterA = new PortalFrameAdapter(document.implementation.createHTMLDocument('a'))
      const adapterB = new PortalFrameAdapter(document.implementation.createHTMLDocument('b'))

      registerFrameAdapter(iframeA, adapterA, 'desktop')
      registerFrameAdapter(iframeB, adapterB, 'mobile')

      const registrations = listFrameAdapterRegistrations()
      expect(registrations.get(iframeA)).toEqual({ adapter: adapterA, breakpointId: 'desktop' })
      expect(registrations.get(iframeB)).toEqual({ adapter: adapterB, breakpointId: 'mobile' })

      unregisterFrameAdapter(iframeA)
      unregisterFrameAdapter(iframeB)
      adapterA.dispose()
      adapterB.dispose()
    })

    it('re-registering the same iframe with a different breakpoint id replaces it', () => {
      const iframe = makeIframe()
      const first = new PortalFrameAdapter(document.implementation.createHTMLDocument('first'))
      const second = new PortalFrameAdapter(document.implementation.createHTMLDocument('second'))

      registerFrameAdapter(iframe, first, 'desktop')
      registerFrameAdapter(iframe, second, 'mobile')

      expect(listFrameAdapterRegistrations().get(iframe)).toEqual({ adapter: second, breakpointId: 'mobile' })

      unregisterFrameAdapter(iframe)
      first.dispose()
      second.dispose()
    })

    it('unregister removes the registration too, not just the adapter-only view', () => {
      const iframe = makeIframe()
      const adapter = new PortalFrameAdapter(document.implementation.createHTMLDocument('doc'))
      registerFrameAdapter(iframe, adapter, 'desktop')

      unregisterFrameAdapter(iframe)

      expect(listFrameAdapterRegistrations().has(iframe)).toBe(false)
      adapter.dispose()
    })
  })
})
