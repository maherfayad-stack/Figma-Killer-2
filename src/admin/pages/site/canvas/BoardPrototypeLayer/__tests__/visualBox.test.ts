/**
 * `visualBox` — the rule that a node with no box of its own is still somewhere.
 *
 * THE BUG THIS PINS
 * ─────────────────
 * Studio renders every component that comes out of a design-system package as a
 * `display: contents` wrapper carrying the node id: the id has to live on an
 * element, and that element must not add a box or it breaks the CSS combinators
 * the published DOM depends on. `getBoundingClientRect()` on such an element is
 * `0×0`, so the prototype layer measured every design-system component as
 * "renders nothing", drew no `+` handle on it, and silently refused to be the
 * source of a link. Every button in a real project is one of those components,
 * so the feature worked on plain `<p>`/`<h1>` and on nothing a user would
 * actually want to make clickable.
 *
 * happy-dom has NO LAYOUT ENGINE — every rect it reports is zero — so a test
 * that mounted real elements could not tell the fixed behaviour from the broken
 * one. What is testable, and what actually went wrong, is the DECISION: when
 * the element's own rect is empty, ask its contents. These stubs supply the
 * rects a browser would, and assert which one is chosen.
 */
import { describe, expect, it } from 'bun:test'
import { visualBox } from '../usePrototypeEndpoints'

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
}

const EMPTY = rect(0, 0, 0, 0)

/** An element whose own rect is `own` and whose contents measure `contents`. */
function elementWith(own: DOMRect, contents: DOMRect): Element {
  return {
    getBoundingClientRect: () => own,
    ownerDocument: {
      createRange: () => ({
        selectNodeContents: () => {},
        getBoundingClientRect: () => contents,
        detach: () => {},
      }),
    },
  } as unknown as Element
}

describe('visualBox', () => {
  it('uses the element\'s own rect when it has one', () => {
    const own = rect(10, 20, 100, 40)
    expect(visualBox(elementWith(own, rect(0, 0, 999, 999)))).toBe(own)
  })

  it('falls back to the contents of a display:contents node', () => {
    // The design-system component case: the id-carrying wrapper has no box,
    // the button inside it does.
    const contents = rect(16, 283, 361, 48)
    expect(visualBox(elementWith(EMPTY, contents))).toBe(contents)
  })

  it('keeps a zero-width element that still has height', () => {
    // A 0×N box is a real box — a collapsed flex child, an empty inline. Only
    // BOTH dimensions being zero means "no box of its own".
    const own = rect(5, 5, 0, 24)
    expect(visualBox(elementWith(own, rect(0, 0, 100, 100)))).toBe(own)
  })

  it('is null when neither the element nor its contents render anything', () => {
    expect(visualBox(elementWith(EMPTY, EMPTY))).toBeNull()
  })
})
