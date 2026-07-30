/**
 * Smoke tests for the hole runtime JavaScript source.
 *
 * The test environment preloads `happy-dom` (via `bunfig.toml` → `setup.ts`),
 * which provides `IntersectionObserver`, `document`, and `fetch` globals.
 *
 * These tests verify:
 *   1. The runtime source contains the expected IntersectionObserver API calls.
 *   2. The runtime source parses (no SyntaxError).
 *   3. The runtime registers an observer for every `<studio-hole[data-studio-hole]>` element.
 *   4. When an IntersectionObserver callback fires with isIntersecting=true,
 *      the runtime calls `fetch` with the correct URL and swaps `el.outerHTML`.
 *
 * We drive the `IntersectionObserver` callbacks manually since happy-dom does
 * not fire them based on real viewport layout.
 */

import { describe, it, expect } from 'bun:test'
import {
  HOLE_RUNTIME_JS,
  runStudioHoleRuntime,
} from '../../../server/publish/holeRuntime'

describe('HOLE_RUNTIME_JS — static source content', () => {
  it('parses and keeps the non-behavioral runtime constants wired', () => {
    expect(() => {
      new Bun.Transpiler({ loader: 'js' }).transformSync(HOLE_RUNTIME_JS)
    }).not.toThrow()
    expect(HOLE_RUNTIME_JS).toContain('IntersectionObserver')
    expect(HOLE_RUNTIME_JS).toContain('200px')
    expect(HOLE_RUNTIME_JS).toContain('encodeURIComponent')
    expect(HOLE_RUNTIME_JS).toContain('studioHole')
    expect(HOLE_RUNTIME_JS).toContain('studioVersion')
    expect(HOLE_RUNTIME_JS).toContain('/_studio/hole/')
    expect(HOLE_RUNTIME_JS).not.toMatch(/\.innerHTML\s*=/)
    expect(HOLE_RUNTIME_JS).toContain('.catch(')
  })
})

// ---------------------------------------------------------------------------
// Runtime behaviour — DOM-driven
//
// A `<studio-hole>` is `display:contents` and has NO layout box, so the runtime
// observes its placeholder CHILD (which does have a box) and swaps the whole
// hole when the child intersects. Holes with no placeholder child are fetched
// eagerly on load (nothing to lazily reveal).
// ---------------------------------------------------------------------------

describe('HOLE_RUNTIME_JS — runtime behaviour with mock IntersectionObserver', () => {
  it('observes each hole\'s placeholder child (not the boxless studio-hole)', () => {
    document.body.innerHTML = `
      <studio-hole id="hole-a" data-studio-hole="node-a" data-studio-version="1" style="display:contents"><div class="sk">a</div></studio-hole>
      <studio-hole id="hole-b" data-studio-hole="node-b" data-studio-version="1" style="display:contents"><div class="sk">b</div></studio-hole>
    `

    const observedElements: Element[] = []
    let capturedCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null

    const originalIO = globalThis.IntersectionObserver
    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        capturedCallback = callback
      }
      observe(el: Element) {
        observedElements.push(el)
      }
      unobserve(_el: Element) {}
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      runStudioHoleRuntime()

      // Two placeholder children observed — NOT the studio-hole elements themselves.
      expect(observedElements.length).toBe(2)
      expect(observedElements.every((el) => el.tagName === 'DIV')).toBe(true)
      expect(capturedCallback).not.toBeNull()
    } finally {
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })

  it('fetches the correct URL and swaps the whole hole when the child intersects', async () => {
    document.body.innerHTML = `
      <studio-hole id="hole-c" data-studio-hole="node-c" data-studio-version="42" style="display:contents"><div class="sk">skeleton</div></studio-hole>
    `

    const fetchedUrls: string[] = []
    const unobservedElements: Element[] = []
    let capturedCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null

    const originalFetch = globalThis.fetch
    const originalIO = globalThis.IntersectionObserver

    ;(globalThis as Record<string, unknown>).fetch = (url: string) => {
      fetchedUrls.push(url)
      return Promise.resolve({ text: () => Promise.resolve('<span>Loaded content</span>') })
    }

    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        capturedCallback = callback
      }
      observe(_el: Element) {}
      unobserve(el: Element) {
        unobservedElements.push(el)
      }
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      runStudioHoleRuntime()

      const child = document.querySelector('#hole-c .sk')!

      // The observer fires for the CHILD; the runtime resolves the enclosing
      // <studio-hole> via closest() and swaps it.
      capturedCallback?.([{ isIntersecting: true, target: child } as IntersectionObserverEntry])

      // Flush the fetch → text() → outerHTML promise chain (macrotask).
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(fetchedUrls.length).toBeGreaterThanOrEqual(1)
      const fetchedUrl = fetchedUrls[0]
      expect(fetchedUrl).toContain('/_studio/hole/')
      expect(fetchedUrl).toContain('node-c')
      expect(fetchedUrl).toContain('v=')
      expect(fetchedUrl).toContain('42')
      // The child (the observed target) is unobserved — single-flight.
      expect(unobservedElements.length).toBe(1)
      // The <studio-hole> is replaced by the fetched fragment (skeleton gone,
      // loaded content present).
      expect(document.body.innerHTML).toContain('Loaded content')
      expect(document.body.innerHTML).not.toContain('skeleton')
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })

  it('eager-fetches a hole that has no placeholder child', async () => {
    document.body.innerHTML = `
      <studio-hole id="hole-e" data-studio-hole="node-e" data-studio-version="7" style="display:contents"></studio-hole>
    `

    const fetchedUrls: string[] = []
    const observedElements: Element[] = []

    const originalFetch = globalThis.fetch
    const originalIO = globalThis.IntersectionObserver

    ;(globalThis as Record<string, unknown>).fetch = (url: string) => {
      fetchedUrls.push(url)
      return Promise.resolve({ text: () => Promise.resolve('<span>x</span>') })
    }
    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(_callback: (entries: IntersectionObserverEntry[]) => void) {}
      observe(el: Element) {
        observedElements.push(el)
      }
      unobserve(_el: Element) {}
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      runStudioHoleRuntime()
      await Promise.resolve()
      await Promise.resolve()

      // Nothing observed (no child box); fetched eagerly on load instead.
      expect(observedElements.length).toBe(0)
      expect(fetchedUrls.length).toBe(1)
      expect(fetchedUrls[0]).toContain('node-e')
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })

  it('does NOT fetch when the observed child is not intersecting', () => {
    document.body.innerHTML = `
      <studio-hole id="hole-d" data-studio-hole="node-d" data-studio-version="1" style="display:contents"><div class="sk">d</div></studio-hole>
    `

    const fetchedUrls: string[] = []
    let capturedCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null

    const originalFetch = globalThis.fetch
    const originalIO = globalThis.IntersectionObserver

    ;(globalThis as Record<string, unknown>).fetch = (url: string) => {
      fetchedUrls.push(url)
      return Promise.resolve({ text: () => Promise.resolve('') })
    }
    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        capturedCallback = callback
      }
      observe(_el: Element) {}
      unobserve(_el: Element) {}
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      runStudioHoleRuntime()

      const child = document.querySelector('#hole-d .sk')!
      capturedCallback?.([{ isIntersecting: false, target: child } as IntersectionObserverEntry])

      expect(fetchedUrls.length).toBe(0)
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })
})
