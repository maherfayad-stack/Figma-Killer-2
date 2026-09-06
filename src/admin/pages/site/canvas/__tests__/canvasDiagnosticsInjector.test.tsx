/**
 * CanvasDiagnosticsInjector — the collector, against a real `<iframe>`.
 *
 * What is worth proving here is not "an event was recorded" but the three
 * decisions the collector makes that a later reader cannot second-guess:
 *
 *   1. A failed `<img>` and a thrown exception are DIFFERENT findings with
 *      different codes and different fixes.
 *   2. `console.error` still reaches the frame's real console — a diagnostics
 *      tap that swallows the message it taps is a regression, not a feature.
 *   3. Uninstalling drops the buffer, so a re-mounted frame cannot report a
 *      fixed error as still live.
 *
 * It also proves the thing the canvas rules care about: the injector adds no
 * DOM to the frame.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { CanvasDiagnosticsInjector } from '../CanvasDiagnosticsInjector'
import { readFrameDiagnostics } from '../canvasDiagnosticsBuffer'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function mountIframe(): { view: Window & typeof globalThis; doc: Document } {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  const view = iframe.contentWindow
  if (!doc || !view) throw new Error('test environment produced no iframe document')
  return { view: view as unknown as Window & typeof globalThis, doc }
}

function codes(view: Window): string[] {
  return (readFrameDiagnostics(view)?.entries ?? []).map((e) => e.code)
}

describe('CanvasDiagnosticsInjector', () => {
  it('installs a buffer and inserts nothing into the frame', () => {
    const { view, doc } = mountIframe()
    const bodyHtmlBefore = doc.body.innerHTML
    render(<CanvasDiagnosticsInjector targetDocument={doc} />)

    expect(readFrameDiagnostics(view)).not.toBeNull()
    expect(doc.body.innerHTML).toBe(bodyHtmlBefore)
    expect(doc.head.querySelectorAll('style, script, link')).toHaveLength(0)
  })

  it('records an uncaught error with its file and line', () => {
    const { view, doc } = mountIframe()
    render(<CanvasDiagnosticsInjector targetDocument={doc} />)

    const event = new Event('error') as Event & { message?: string; filename?: string; lineno?: number }
    event.message = "TypeError: Cannot read properties of undefined (reading 'map')"
    event.filename = 'blob:studio/checkout'
    event.lineno = 42
    view.dispatchEvent(event)

    const entry = readFrameDiagnostics(view)?.entries[0]
    expect(entry?.code).toBe('runtime-uncaught-error')
    expect(entry?.line).toBe(42)
    expect(entry?.count).toBe(1)
  })

  it('classifies a module specifier failure apart from an ordinary throw', () => {
    const { view, doc } = mountIframe()
    render(<CanvasDiagnosticsInjector targetDocument={doc} />)

    const event = new Event('error') as Event & { message?: string }
    event.message = 'TypeError: Failed to resolve module specifier "@acme/ui"'
    view.dispatchEvent(event)

    // Same channel, completely different fix: install a dependency, not debug a component.
    expect(codes(view)).toEqual(['module-resolution-failed'])
  })

  it('records a failed asset load against the node that referenced it', () => {
    const { view, doc } = mountIframe()
    render(<CanvasDiagnosticsInjector targetDocument={doc} />)

    const host = doc.createElement('div')
    host.setAttribute('data-node-id', 'pages/Checkout.tsx:42:7')
    const img = doc.createElement('img')
    img.setAttribute('src', '/hero.png')
    host.appendChild(img)
    doc.body.appendChild(host)

    const event = new Event('error')
    Object.defineProperty(event, 'target', { value: img, configurable: true })
    view.dispatchEvent(event)

    const entry = readFrameDiagnostics(view)?.entries[0]
    expect(entry?.code).toBe('asset-load-failed')
    expect(entry?.url).toBe('/hero.png')
    // The node id is a source position — this is what makes the finding actionable.
    expect(entry?.nodeId).toBe('pages/Checkout.tsx:42:7')
  })

  it('taps console.error without swallowing it, and counts repeats as one finding', () => {
    const { view, doc } = mountIframe()
    const seen: unknown[][] = []
    view.console.error = (...args: unknown[]) => { seen.push(args) }
    render(<CanvasDiagnosticsInjector targetDocument={doc} />)

    view.console.error('Warning: Each child in a list should have a unique "key" prop.')
    view.console.error('Warning: Each child in a list should have a unique "key" prop.')

    // Passed through, both times.
    expect(seen).toHaveLength(2)
    const entries = readFrameDiagnostics(view)?.entries ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]?.code).toBe('runtime-console-error')
    expect(entries[0]?.count).toBe(2)
  })

  it('restores console.error and drops the buffer on unmount', () => {
    const { view, doc } = mountIframe()
    const original = view.console.error
    const { unmount } = render(<CanvasDiagnosticsInjector targetDocument={doc} />)
    expect(view.console.error).not.toBe(original)

    unmount()
    expect(view.console.error).toBe(original)
    // A stale buffer surviving a remount would report a fixed error as live.
    expect(readFrameDiagnostics(view)).toBeNull()
  })

  it('records an unhandled rejection with the reason it carried', () => {
    const { view, doc } = mountIframe()
    render(<CanvasDiagnosticsInjector targetDocument={doc} />)

    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = new Error('checkout session expired')
    view.dispatchEvent(event)

    const entry = readFrameDiagnostics(view)?.entries[0]
    expect(entry?.code).toBe('runtime-unhandled-rejection')
    expect(entry?.message).toContain('checkout session expired')
  })
})
