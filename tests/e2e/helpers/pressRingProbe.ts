import type { Frame, Locator, Page } from '@playwright/test'

/**
 * The first ring a press shows. A press does not wait for React: it restyles
 * the frame's hover ring as a selection ring with one attribute
 * (`data-canvas-press-ring`, `canvas/pressRing.ts`), and the REAL selection
 * ring (`data-canvas-selection-ring`) follows once the selection has rendered.
 * A spec that measures "the first visible ring" must accept either, or it
 * measures the commit and calls the press slow. Both are parent-document chrome
 * beside the iframe (SB-4): the probes below watch the PARENT document.
 */
export const FIRST_RING_SELECTOR = '[data-canvas-selection-ring="true"], [data-canvas-hover-ring][data-canvas-press-ring]'

/** The attributes a ring's appearance can flip on, for a `MutationObserver` watching for it. */
export const FIRST_RING_ATTRIBUTES = ['style', 'data-canvas-overlay-node-id', 'data-canvas-press-ring']

export interface PressTarget {
  id: string
  x: number
  y: number
}

/** Hittable press targets in `content` (`iframe` is that frame's own element), in page coordinates: on screen, and not covered by editor chrome. */
export async function hittableTargets(page: Page, iframe: Locator, content: Frame): Promise<PressTarget[]> {
  const box = await iframe.boundingBox()
  if (!box) throw new Error('the target iframe has no bounding box')
  const probe = await content.evaluate(() => ({
    width: document.documentElement.clientWidth,
    targets: Array.from(document.querySelectorAll('.block__heading, .block__body, .row__label'))
      .map((el) => ({ id: el.getAttribute('data-node-id'), rect: el.getBoundingClientRect() }))
      .filter((t) => t.id !== null && t.rect.width > 0)
      .map((t) => ({ id: t.id!, x: t.rect.left + t.rect.width / 2, y: t.rect.top + t.rect.height / 2 })),
  }))
  const scale = box.width / probe.width
  const targets = probe.targets.map((t) => ({ id: t.id, x: box.x + t.x * scale, y: box.y + t.y * scale }))
  const hittable = await page.evaluate(
    ({ points, iframeTop }) => points.map((p) => p.y > iframeTop && document.elementFromPoint(p.x, p.y)?.tagName === 'IFRAME'),
    { points: targets, iframeTop: 120 },
  )
  return targets.filter((_, index) => hittable[index])
}

export interface PressProbeResult {
  /** pointerdown to the first visible ring of either kind, ms (0 when none appeared). */
  firstRingMs: number
  firstRingKind: 'press' | 'selection' | 'none'
  /** pointerdown to the real selection ring, ms (0 when none appeared). */
  realRingMs: number
  /** Animation frames, from the first ring until `readPressProbe`, on which NO ring of either kind was visible. */
  gapFrames: number
  frames: number
  /** Node ids the real selection ring named (more than one is a two-phase selection). */
  realIds: string[]
}

interface PressProbeState {
  downAt: number
  firstAt: number
  firstKind: string
  realAt: number
  gaps: number
  frames: number
  ids: Set<string>
  stop: boolean
}

/**
 * Install the probe: the next `pointerdown` in `iframe`'s document starts the clock, and the parent document is
 * watched for rings. Both listeners run in the parent's JS realm, so one `performance.now()` times both.
 */
export async function installPressProbe(iframe: Locator): Promise<void> {
  await iframe.evaluate(
    (element, args) => {
      const state: PressProbeState = { downAt: 0, firstAt: 0, firstKind: 'none', realAt: 0, gaps: 0, frames: 0, ids: new Set<string>(), stop: false }
      ;(window as unknown as { __pressProbe: PressProbeState }).__pressProbe = state
      const visible = () => Array.from(document.querySelectorAll<HTMLElement>(args.ring)).filter((el) => el.style.display !== 'none')
      const read = () => {
        if (state.downAt === 0) return
        const rings = visible()
        for (const el of rings) {
          if (el.hasAttribute('data-canvas-selection-ring')) {
            state.ids.add(el.getAttribute('data-canvas-overlay-node-id') ?? '')
            if (state.realAt === 0) state.realAt = performance.now()
          }
        }
        if (rings.length > 0 && state.firstAt === 0) {
          state.firstAt = performance.now()
          state.firstKind = rings.some((el) => el.hasAttribute('data-canvas-selection-ring')) ? 'selection' : 'press'
        }
      }
      new MutationObserver(read).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: args.attributes })
      const frame = () => {
        if (state.stop) return
        state.frames += 1
        read()
        if (state.firstAt !== 0 && visible().length === 0) state.gaps += 1
        requestAnimationFrame(frame)
      }
      ;(element as HTMLIFrameElement).contentDocument!.addEventListener(
        'pointerdown',
        () => {
          state.downAt = performance.now()
          requestAnimationFrame(frame)
        },
        { capture: true, once: true },
      )
    },
    { ring: FIRST_RING_SELECTOR, attributes: FIRST_RING_ATTRIBUTES },
  )
}

/** Stop the probe and read what it saw. */
export async function readPressProbe(page: Page): Promise<PressProbeResult> {
  return page.evaluate(() => {
    const s = (window as unknown as { __pressProbe: { downAt: number; firstAt: number; firstKind: string; realAt: number; gaps: number; frames: number; ids: Set<string>; stop: boolean } }).__pressProbe
    s.stop = true
    return {
      firstRingMs: s.firstAt === 0 ? 0 : s.firstAt - s.downAt,
      firstRingKind: s.firstKind as 'press' | 'selection' | 'none',
      realRingMs: s.realAt === 0 ? 0 : s.realAt - s.downAt,
      gapFrames: s.gaps,
      frames: s.frames,
      realIds: Array.from(s.ids),
    }
  })
}
