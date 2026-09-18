/**
 * The DOM half of K6's reflow preview: how `canvasDragPainter` draws the
 * siblings that make room.
 *
 * Three properties, each of which a plausible implementation gets wrong:
 *
 *  1. **The pool is fixed and eager.** The set of shifting siblings changes
 *     every time the drop line crosses a slot; creating and removing elements
 *     for it would be DOM mutation at pointer rate, which is the whole thing
 *     this painter exists to avoid.
 *  2. **A box that stops shifting travels back to zero and is hidden**, rather
 *     than being left holding the last delta it was given. Without that, the
 *     next gesture starts every box somewhere it should not be.
 *  3. **Position and shift are different channels.** The rect goes in through
 *     `--canvas-drop-*` (a `transform`); the delta is the `translate`
 *     property. Sharing one would mean a re-measure slid the box across the
 *     frame instead of repositioning it.
 *
 * happy-dom has no Web Animations API, so the painter's documented fallback —
 * write the final `translate` outright — is what runs here. That is also
 * exactly what `prefers-reduced-motion` produces in a real browser, so this
 * suite doubles as the reduced-motion assertion.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { paintCanvasDrag } from '@site/canvas/canvasDragPainter'
import { REFLOW_SHIFT_LIMIT } from '@site/canvas/canvasReflowPreview'

function rect(top: number, height: number) {
  return { left: 0, top, right: 300, bottom: top + height, width: 300, height }
}

function layer(): HTMLElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

// Named by the stable data attribute, never the hashed CSS Module class — the
// class name does not survive a bun-test import of the stylesheet, and the
// painter's own docs use this attribute as the box's identity.
function reflowBoxes(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll('[data-canvas-reflow-ghost]')] as HTMLElement[]
}

function shifting(host: HTMLElement): HTMLElement[] {
  return reflowBoxes(host).filter((box) => box.getAttribute('data-shifting') === 'true')
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('paintCanvasDrag — the reflow pool', () => {
  it('mints the whole pool once and never grows or shrinks it', () => {
    const host = layer()
    paintCanvasDrag(host, { target: null, invalid: null, ghost: null, reflow: [] })
    expect(reflowBoxes(host)).toHaveLength(REFLOW_SHIFT_LIMIT)

    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: null,
      reflow: [{ nodeId: 'a', rect: rect(0, 40), dx: 0, dy: 50 }],
    })
    expect(reflowBoxes(host)).toHaveLength(REFLOW_SHIFT_LIMIT)
  })

  it('shows exactly as many boxes as there are siblings making room', () => {
    const host = layer()
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: null,
      reflow: [
        { nodeId: 'a', rect: rect(0, 40), dx: 0, dy: 50 },
        { nodeId: 'b', rect: rect(50, 40), dx: 0, dy: 50 },
      ],
    })
    expect(shifting(host)).toHaveLength(2)
  })

  it('places a box on its sibling’s rect and carries the delta on a SEPARATE channel', () => {
    const host = layer()
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: null,
      reflow: [{ nodeId: 'a', rect: rect(120, 40), dx: 0, dy: -55 }],
    })

    const box = shifting(host)[0]!
    expect(box.style.getPropertyValue('--canvas-drop-y')).toBe('120px')
    expect(box.style.getPropertyValue('--canvas-drop-h')).toBe('40px')
    expect(box.style.translate).toBe('0px -55px')
  })

  it('travels a box that stops shifting back to zero and hides it', () => {
    const host = layer()
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: null,
      reflow: [{ nodeId: 'a', rect: rect(0, 40), dx: 0, dy: 50 }],
    })
    const box = reflowBoxes(host)[0]!
    expect(box.style.translate).toBe('0px 50px')

    paintCanvasDrag(host, { target: null, invalid: null, ghost: null, reflow: [] })
    expect(box.style.translate).toBe('0px 0px')
    expect(box.hasAttribute('data-shifting')).toBe(false)
  })

  it('resets every box when the gesture ends, so the next drag starts at rest', () => {
    const host = layer()
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: null,
      reflow: [{ nodeId: 'a', rect: rect(0, 40), dx: 0, dy: 50 }],
    })
    paintCanvasDrag(host, null)

    for (const box of reflowBoxes(host)) {
      expect(box.style.translate).toBe('0px 0px')
      expect(box.hasAttribute('data-shifting')).toBe(false)
    }
  })

  it('draws nothing at all for a paint that carries no reflow', () => {
    const host = layer()
    paintCanvasDrag(host, { target: null, invalid: null, ghost: null })
    expect(shifting(host)).toHaveLength(0)
  })
})

describe('paintCanvasDrag — the refusing ghost (G15)', () => {
  it('marks the cursor chip as a refusal so it reads before release, not after', () => {
    const host = layer()
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: { point: { x: 10, y: 20 }, label: 'Drop onto a frame', duplicating: false, refusing: true },
    })
    const ghost = [...host.children].find((child) =>
      child.hasAttribute('data-canvas-drag-ghost'),
    ) as HTMLElement
    expect(ghost.getAttribute('data-refusing')).toBe('true')
    expect(ghost.textContent).toBe('Drop onto a frame')
  })

  it('drops the refusal mark when the same chip goes back to describing a real drop', () => {
    const host = layer()
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: { point: { x: 10, y: 20 }, label: 'PDF', duplicating: false, refusing: true },
    })
    paintCanvasDrag(host, {
      target: null,
      invalid: null,
      ghost: { point: { x: 10, y: 20 }, label: 'PNG image', duplicating: false },
    })
    const ghost = [...host.children].find((child) =>
      child.hasAttribute('data-canvas-drag-ghost'),
    ) as HTMLElement
    expect(ghost.hasAttribute('data-refusing')).toBe(false)
  })
})
