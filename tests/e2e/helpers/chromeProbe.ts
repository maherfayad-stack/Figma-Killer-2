import type { Locator, Page } from '@playwright/test'

/**
 * chromeProbe — latency probes for selection chrome that lives in the PARENT
 * document (SB-4), timed against an event that happens INSIDE a frame.
 *
 * The rings, handles and badges are editor DOM beside the iframe, so a
 * `MutationObserver` on the parent `document.body` sees them; the pointer event
 * that starts the clock is raised in the frame's own document, which the parent
 * can listen on directly (same origin). Both listeners run in the parent's JS
 * realm, so one `performance.now()` is the clock for both — no cross-document
 * time-origin arithmetic.
 *
 * "Ring painted" is the first animation frame after the ring exists, the same
 * definition the in-frame probes used.
 */

interface RingProbeState {
  downAt: number
  ringAt: number
  paintAt: number
  observer: MutationObserver | null
  /** The hover ring's node id before the gesture (hover probes only). */
  before: string | null
}

interface ProbeWindow {
  __chromeProbe?: RingProbeState
}

/** The attributes a ring's appearance can flip on, for a `MutationObserver` watching for it. */
export const RING_ATTRIBUTES = ['style', 'data-canvas-overlay-node-id', 'data-canvas-press-ring']

/** What counts as "the ring exists" for a click on `nodeId`: the borrowed hover ring (a press) or the real selection ring. */
export const CLICK_RING_SELECTOR = '[data-canvas-selection-ring="true"], [data-canvas-hover-ring][data-canvas-press-ring]'

/**
 * Arms a click probe: the next `pointerdown` in `iframe`'s document starts the
 * clock; it stops one animation frame after a ring for `nodeId` is visible (the
 * press ring names no layer, so it counts when `acceptPressRing`).
 */
export async function armClickProbe(iframe: Locator, nodeId: string, options: { acceptPressRing: boolean }): Promise<void> {
  await iframe.evaluate(
    (element, args) => {
      const state: RingProbeState = { downAt: 0, ringAt: 0, paintAt: 0, observer: null, before: null }
      ;(window as unknown as ProbeWindow).__chromeProbe = state
      const doc = (element as HTMLIFrameElement).contentDocument!
      doc.addEventListener('pointerdown', () => { if (state.downAt === 0) state.downAt = performance.now() }, { capture: true, once: true })
      const check = () => {
        if (state.ringAt !== 0 || state.downAt === 0) return
        const ring = Array.from(document.querySelectorAll(args.selector)).find(
          (el) =>
            (el.getAttribute('data-canvas-overlay-node-id') === args.nodeId || (args.acceptPressRing && el.hasAttribute('data-canvas-press-ring'))) &&
            (el as HTMLElement).style.display !== 'none',
        )
        if (!ring) return
        state.ringAt = performance.now()
        requestAnimationFrame(() => { state.paintAt = performance.now() })
      }
      state.observer = new MutationObserver(check)
      state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: args.attributes })
    },
    { selector: CLICK_RING_SELECTOR, nodeId, acceptPressRing: options.acceptPressRing, attributes: RING_ATTRIBUTES },
  )
}

/** Waits (up to 1 s) for the armed probe to see its ring painted; the click-to-paint time in ms, or `-1`. */
export async function readRingProbe(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const state = (window as unknown as ProbeWindow).__chromeProbe
    if (!state) return -1
    for (let wait = 0; wait < 100 && state.paintAt === 0; wait += 1) await new Promise((r) => setTimeout(r, 10))
    state.observer?.disconnect()
    return state.downAt === 0 || state.paintAt === 0 ? -1 : state.paintAt - state.downAt
  })
}

/**
 * Arms a hover probe: the next `pointermove` in `iframe`'s document starts the
 * clock; it stops one animation frame after the hover ring names a DIFFERENT node
 * than it did when armed.
 */
export async function armHoverProbe(iframe: Locator): Promise<void> {
  await iframe.evaluate((element) => {
    const ring = () => document.querySelector<HTMLElement>('[data-canvas-hover-ring]')
    const state: RingProbeState = { downAt: 0, ringAt: 0, paintAt: 0, observer: null, before: ring()?.getAttribute('data-canvas-overlay-node-id') ?? null }
    ;(window as unknown as ProbeWindow).__chromeProbe = state
    const doc = (element as HTMLIFrameElement).contentDocument!
    doc.addEventListener('pointermove', () => { if (state.downAt === 0) state.downAt = performance.now() }, { capture: true, once: true })
    const check = () => {
      if (state.ringAt !== 0 || state.downAt === 0) return
      // Every frame has its own hover ring; the one that changed is the one that names a new node.
      const changed = Array.from(document.querySelectorAll<HTMLElement>('[data-canvas-hover-ring]')).find((el) => {
        const id = el.getAttribute('data-canvas-overlay-node-id')
        return el.style.display !== 'none' && id !== null && id !== state.before
      })
      if (!changed) return
      state.ringAt = performance.now()
      requestAnimationFrame(() => { state.paintAt = performance.now() })
    }
    state.observer = new MutationObserver(check)
    state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-canvas-overlay-node-id'] })
  })
}
