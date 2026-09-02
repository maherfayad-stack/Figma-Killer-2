/**
 * `canvasZoomOf` reads the transform matrix, not a size ratio.
 *
 * The regression it guards: comment placement recovered zoom as
 * `rect.width / offsetWidth`, which is 0/0 for the canvas transform layer
 * (every board frame is absolutely positioned, so the layer has no in-flow
 * content). The `> 0` guard then returned a plausible-looking 1, and pins
 * dropped at 50% zoom were stored twice as far from their frame's corner as
 * the user had clicked.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { canvasZoomOf } from '@site/canvas/canvasZoom'

const originals = {
  getComputedStyle: globalThis.getComputedStyle,
  DOMMatrixReadOnly: globalThis.DOMMatrixReadOnly,
}

/**
 * Bun's test environment has no `DOMMatrixReadOnly`, so stand one up that
 * parses the `matrix(a, b, c, d, e, f)` form the browser actually serialises
 * a 2D transform to. The point under test is which value this code READS and
 * what it does with it, not the browser's matrix parser.
 */
class StubMatrix {
  a: number
  constructor(transform: string) {
    const parts = transform.match(/matrix\(([^)]*)\)/)
    if (!parts) throw new SyntaxError(`not a matrix: ${transform}`)
    this.a = Number(parts[1]!.split(',')[0])
  }
}

function withTransform(transform: string): HTMLElement {
  globalThis.getComputedStyle = (() => ({ transform })) as unknown as typeof getComputedStyle
  globalThis.DOMMatrixReadOnly = StubMatrix as unknown as typeof DOMMatrixReadOnly
  // offsetWidth 0 — the exact condition the old ratio-based recovery hit.
  return { offsetWidth: 0 } as unknown as HTMLElement
}

afterEach(() => {
  globalThis.getComputedStyle = originals.getComputedStyle
  globalThis.DOMMatrixReadOnly = originals.DOMMatrixReadOnly
})

describe('canvasZoomOf', () => {
  it('reads the scale from a matrix on a zero-sized element', () => {
    // The exact shape that broke: offsetWidth 0, real zoom 0.5.
    expect(canvasZoomOf(withTransform('matrix(0.5, 0, 0, 0.5, 0, 0)'))).toBe(0.5)
  })

  it('handles an untransformed layer', () => {
    expect(canvasZoomOf(withTransform('none'))).toBe(1)
  })

  it('refuses a zero or negative scale rather than returning Infinity later', () => {
    expect(canvasZoomOf(withTransform('matrix(0, 0, 0, 0, 0, 0)'))).toBe(1)
    expect(canvasZoomOf(withTransform('matrix(-2, 0, 0, -2, 0, 0)'))).toBe(1)
  })

  it('falls back when the environment has no DOMMatrixReadOnly', () => {
    const el = withTransform('matrix(0.5, 0, 0, 0.5, 0, 0)')
    // @ts-expect-error — deleting a global for the duration of this assertion.
    delete globalThis.DOMMatrixReadOnly
    expect(canvasZoomOf(el)).toBe(1)
  })
})
