/**
 * CanvasScrollUnrollInjector — DOM wiring tests. Pure classification is
 * covered by `canvasScrollUnroll.test.ts`; this file covers the stylesheet
 * mount/unmount contract and the tagging pass against real (stubbed) DOM
 * geometry, following the shape of `canvasAnimationInjector.test.tsx`.
 *
 * happy-dom has no real layout engine, so `scrollHeight`/`clientHeight` are
 * always 0 unless stubbed — tests that need a "clipping" element define both
 * with `Object.defineProperty` (an own property shadows the prototype
 * accessor regardless of the accessor's own configurability, so this works
 * without needing happy-dom-specific APIs).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { CanvasScrollUnrollInjector } from '@site/canvas/CanvasScrollUnrollInjector'
import { SCROLL_UNROLL_ATTR, SCROLL_UNROLL_MIN_HEIGHT_VAR } from '@site/canvas/canvasScrollUnroll'

const STYLE_TAG_ID = 'studio-canvas-scroll-unroll'

function stubClipping(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
}

afterEach(() => {
  cleanup()
  document.getElementById(STYLE_TAG_ID)?.remove()
  for (const el of document.querySelectorAll(`[${SCROLL_UNROLL_ATTR}]`)) {
    el.removeAttribute(SCROLL_UNROLL_ATTR)
  }
})

/**
 * NOT covered here: the authored-`min-height` floor pass (and, for the same
 * reason, the pre-unroll `overflow-y` snapshot beside it). Both recover the
 * AUTHOR's computed value by disabling this injector's own stylesheet for one
 * synchronous read — and happy-dom reports `styleSheet.disabled === true`
 * while still applying the sheet's rules to `getComputedStyle`, so the
 * scenario cannot be expressed here at all. A DOM test would pass because the
 * marker is never written, not because the logic is right, which is worse
 * than no test. The decision itself is covered exhaustively in
 * `canvasScrollUnroll.test.ts` (`authoredMinHeightFloor`), the stylesheet rule
 * that consumes it is asserted there too, and the end-to-end behaviour was
 * verified against a real board.
 */
describe('CanvasScrollUnrollInjector — stylesheet', () => {
  it('injects a stylesheet by default (enabled defaults on)', () => {
    render(<CanvasScrollUnrollInjector targetDocument={document} />)

    const styleEl = document.getElementById(STYLE_TAG_ID)
    expect(styleEl).not.toBeNull()
    expect(styleEl?.tagName).toBe('STYLE')
    expect(styleEl?.getAttribute('data-source')).toBe('CanvasScrollUnrollInjector')
  })

  it('does not inject a stylesheet when enabled=false', () => {
    render(<CanvasScrollUnrollInjector targetDocument={document} enabled={false} />)

    expect(document.getElementById(STYLE_TAG_ID)).toBeNull()
  })

  it('removes the stylesheet when toggled from enabled to disabled', () => {
    const view = render(<CanvasScrollUnrollInjector targetDocument={document} enabled={true} />)
    expect(document.getElementById(STYLE_TAG_ID)).not.toBeNull()

    view.rerender(<CanvasScrollUnrollInjector targetDocument={document} enabled={false} />)

    expect(document.getElementById(STYLE_TAG_ID)).toBeNull()
  })

  it('removes the stylesheet on unmount', () => {
    const view = render(<CanvasScrollUnrollInjector targetDocument={document} />)
    view.unmount()

    expect(document.getElementById(STYLE_TAG_ID)).toBeNull()
  })

  it('does not stack duplicate style elements when re-rendered', () => {
    const view = render(<CanvasScrollUnrollInjector targetDocument={document} />)
    view.rerender(<CanvasScrollUnrollInjector targetDocument={document} />)

    expect(document.querySelectorAll(`#${STYLE_TAG_ID}`)).toHaveLength(1)
  })
})

describe('CanvasScrollUnrollInjector — tagging pass', () => {
  it('tags a position:fixed element "fixed"', async () => {
    const nav = document.createElement('div')
    nav.style.position = 'fixed'
    document.body.appendChild(nav)

    try {
      render(<CanvasScrollUnrollInjector targetDocument={document} />)

      await waitFor(() => {
        expect(nav.getAttribute(SCROLL_UNROLL_ATTR)).toBe('fixed')
      })
    } finally {
      nav.remove()
    }
  })

  it('tags a clipping element "explicit-height" and floors it at its true content extent (scrollHeight), not its currently-clipped clientHeight', async () => {
    // Regression coverage for a real browser-verified bug (canvas-06):
    // `runUnrollPass` used to re-read `el.clientHeight` AFTER calling
    // `el.setAttribute(SCROLL_UNROLL_ATTR, 'explicit-height')`, which
    // activates this element's OWN `[data-studio-unroll="explicit-height"]
    // { min-height: var(--studio-unroll-min-height) !important }` rule. CSS
    // custom properties inherit — if an ANCESTOR was already tagged earlier
    // in the SAME synchronous pass (querySelectorAll visits ancestors
    // before descendants) and had ITS OWN min-height var set, a descendant
    // being measured before its own local value is written INHERITS the
    // ancestor's (often much larger) value, inflating `clientHeight` to
    // match it — then that inflated number gets baked in as the
    // descendant's own PERMANENT min-height. Measured live on
    // `maherfayad-stack-eSIM`'s homepage: a two-character "66" price label
    // was permanently floored at 1608px (the PAGE ROOT's own, unrelated,
    // correct deficit), tripling the whole page's real content height and
    // overlapping the board frames below it. happy-dom has no layout
    // engine, so it cannot reproduce the inheritance itself — this test
    // instead locks the CONTRACT the fix relies on: the value written is
    // the pre-mutation `scrollHeight` (this element's own true full content
    // extent, immune to any later CSS side effect), never a `clientHeight`
    // re-read after the element's own override is already active.
    const panel = document.createElement('div')
    stubClipping(panel, { scrollHeight: 1600, clientHeight: 812 })
    document.body.appendChild(panel)

    try {
      render(<CanvasScrollUnrollInjector targetDocument={document} />)

      await waitFor(() => {
        expect(panel.getAttribute(SCROLL_UNROLL_ATTR)).toBe('explicit-height')
      })
      expect(panel.style.getPropertyValue(SCROLL_UNROLL_MIN_HEIGHT_VAR)).toBe('1600px')
    } finally {
      panel.remove()
    }
  })

  it('does not tag an element with no clipping and static position', async () => {
    // A known-fixed sibling proves the pass actually ran (rather than racing
    // an arbitrary timeout to prove a negative) — once IT is tagged, the
    // scan has visited every element in this body, including `el`.
    const witness = document.createElement('div')
    witness.style.position = 'fixed'
    const el = document.createElement('div')
    stubClipping(el, { scrollHeight: 100, clientHeight: 100 })
    document.body.appendChild(witness)
    document.body.appendChild(el)

    try {
      render(<CanvasScrollUnrollInjector targetDocument={document} />)
      await waitFor(() => {
        expect(witness.getAttribute(SCROLL_UNROLL_ATTR)).toBe('fixed')
      })
      expect(el.hasAttribute(SCROLL_UNROLL_ATTR)).toBe(false)
    } finally {
      witness.remove()
      el.remove()
    }
  })

  it('does not run the tagging pass when enabled=false', () => {
    const nav = document.createElement('div')
    nav.style.position = 'fixed'
    document.body.appendChild(nav)

    try {
      // enabled=false short-circuits before scheduling any rAF pass, so
      // there is nothing async to wait for.
      render(<CanvasScrollUnrollInjector targetDocument={document} enabled={false} />)
      expect(nav.hasAttribute(SCROLL_UNROLL_ATTR)).toBe(false)
      expect(document.getElementById(STYLE_TAG_ID)).toBeNull()
    } finally {
      nav.remove()
    }
  })

  it('clears tags on unmount so a disabled/removed injector leaves no residue', async () => {
    const nav = document.createElement('div')
    nav.style.position = 'fixed'
    document.body.appendChild(nav)

    try {
      const view = render(<CanvasScrollUnrollInjector targetDocument={document} />)
      await waitFor(() => {
        expect(nav.getAttribute(SCROLL_UNROLL_ATTR)).toBe('fixed')
      })

      view.unmount()

      expect(nav.hasAttribute(SCROLL_UNROLL_ATTR)).toBe(false)
    } finally {
      nav.remove()
    }
  })

  it('tags an element inserted AFTER the initial settle — the MutationObserver path', async () => {
    render(<CanvasScrollUnrollInjector targetDocument={document} />)
    // Let the initial (empty-body) pass settle first, so this specifically
    // exercises the mutation-triggered re-schedule, not the mount pass.
    await waitFor(() => {
      expect(document.getElementById(STYLE_TAG_ID)).not.toBeNull()
    })

    const nav = document.createElement('div')
    nav.style.position = 'fixed'
    document.body.appendChild(nav)

    try {
      await waitFor(() => {
        expect(nav.getAttribute(SCROLL_UNROLL_ATTR)).toBe('fixed')
      })
    } finally {
      nav.remove()
    }
  })
})
