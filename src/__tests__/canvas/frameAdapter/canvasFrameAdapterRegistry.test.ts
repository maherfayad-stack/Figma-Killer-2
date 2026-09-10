/**
 * canvasFrameAdapterRegistry — module-scoped, so each test uses its own
 * throwaway iframe elements as keys rather than resetting global state
 * between tests (there is nothing TO reset except what a test itself adds).
 */
import { describe, expect, it } from 'bun:test'
import {
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

    registerFrameAdapter(iframeA, adapterA)
    registerFrameAdapter(iframeB, adapterB)

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
    registerFrameAdapter(iframeA, adapterA)
    registerFrameAdapter(iframeB, adapterB)

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

    registerFrameAdapter(iframe, first)
    registerFrameAdapter(iframe, second)

    expect(listFrameAdapters().get(iframe)).toBe(second)

    unregisterFrameAdapter(iframe)
    first.dispose()
    second.dispose()
  })
})
