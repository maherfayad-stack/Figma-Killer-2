/**
 * `collectScrollDeficits` — DOM-measurement half of `resolveFrameFitHeight.ts`.
 * Pure-function behaviour (`resolveFrameFitHeight` itself) is covered by
 * `resolveFrameFitHeight.test.ts`; this file is the DOM-geometry half that
 * file has never had coverage for.
 *
 * This is the regression test for the eSIM `esim-manual-entry-screen` bug
 * (STATE.md `canvas-02`): a `position: absolute; inset: 0` overlay root sized
 * against `body`'s pin (`iframeBodyReset.ts`) can have a taller child paint
 * past its own explicit height. Pre-fix, `collectScrollDeficits` only counted
 * a deficit when computed `overflow-y` was `auto`/`scroll` — which excluded
 * this overlay (its own `overflow-y` is `visible`) even though its content
 * genuinely exceeded its box. `CanvasScrollUnrollInjector` makes this common:
 * it force-sets `overflow-y: visible !important` on EVERY element as part of
 * un-clipping internal scroll regions, so any region that used to correctly
 * report a deficit while `auto` stops being counted the moment the injector
 * "fixes" it — the deficit doesn't close, it just becomes invisible to the
 * frame-fit scan, and `documentElement`'s canvas-only `overflow: hidden`
 * clips whatever grew past the never-updated pin.
 *
 * happy-dom has no layout engine, so `scrollHeight`/`clientHeight` are
 * stubbed with `Object.defineProperty` (the pattern `canvasScrollUnrollInjector.test.tsx`
 * already uses) rather than produced by real layout. That proves the GATING
 * LOGIC is now correct — it does not prove real-browser `scrollHeight`
 * reporting for `overflow: visible` boxes matches these stubs; that is the
 * one fact only a real browser can confirm (see the handoff for what still
 * needs a dogfood pass).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { collectScrollDeficits } from '@site/canvas/resolveFrameFitHeight'

function stubBox(
  el: HTMLElement,
  { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('collectScrollDeficits', () => {
  it('finds nothing when nothing overflows', () => {
    const el = document.createElement('div')
    stubBox(el, { scrollHeight: 400, clientHeight: 400 })
    document.body.appendChild(el)

    expect(collectScrollDeficits(document)).toEqual([])
  })

  it('still counts an overflow-y:auto region (unchanged pre-existing behaviour)', () => {
    const region = document.createElement('div')
    region.style.overflowY = 'auto'
    stubBox(region, { scrollHeight: 1000, clientHeight: 400 })
    document.body.appendChild(region)

    expect(collectScrollDeficits(document)).toEqual([600])
  })

  it('still counts an overflow-y:scroll region (unchanged pre-existing behaviour)', () => {
    const region = document.createElement('div')
    region.style.overflowY = 'scroll'
    stubBox(region, { scrollHeight: 900, clientHeight: 500 })
    document.body.appendChild(region)

    expect(collectScrollDeficits(document)).toEqual([400])
  })

  it('still excludes overflow-y:hidden — deliberate design clipping, not a deficit', () => {
    const mask = document.createElement('div')
    mask.style.overflowY = 'hidden'
    stubBox(mask, { scrollHeight: 900, clientHeight: 500 })
    document.body.appendChild(mask)

    expect(collectScrollDeficits(document)).toEqual([])
  })

  it('excludes overflow-y:clip for the same reason as hidden', () => {
    const clipped = document.createElement('div')
    clipped.style.overflowY = 'clip'
    stubBox(clipped, { scrollHeight: 900, clientHeight: 500 })
    document.body.appendChild(clipped)

    expect(collectScrollDeficits(document)).toEqual([])
  })

  // Reverted deliberately after a real-browser pass (`STATE.md` → `test-01`),
  // not weakened to go green. An earlier change (`canvas-02`) counted ANY
  // non-hidden overflow, to fix the eSIM manual-entry-sheet clipping. In
  // Chromium that pinned body at ~2080px instead of ~800px and the frame
  // rendered as a blank box — strictly worse than the bug it targeted.
  //
  // The reason is definitional: for an `overflow: visible` box, `scrollHeight`
  // counts children that are ALREADY PAINTED. That excess is not hidden, so
  // it is not a deficit, and since the caller takes `Math.max(...)` one bogus
  // value dominates. Only a genuinely scrollable box hides content.
  it('does NOT count an overflow-y:visible box — its excess is painted, not hidden', () => {
    const overlay = document.createElement('div')
    stubBox(overlay, { scrollHeight: 900, clientHeight: 800 })
    document.body.appendChild(overlay)

    expect(overlay.style.overflowY).toBe('') // default: visible
    expect(collectScrollDeficits(document)).toEqual([])
  })

  // The real defect this gate still has, recorded as a failing-in-spirit case:
  // `CanvasScrollUnrollInjector` forces every formerly-`auto`/`scroll` region
  // to `visible`, which DESTROYS the signal this scan reads. The fix is to
  // consult the element's pre-unroll overflow — which the injector knows and
  // must record — not to count visible overflow as hidden. Until that lands,
  // this documents the blind spot honestly instead of pretending it is closed.
  it('KNOWN GAP: loses a real scroll region once the unroll injector overwrites its overflow', () => {
    const region = document.createElement('div')
    region.style.overflowY = 'auto'
    stubBox(region, { scrollHeight: 720, clientHeight: 480 })
    document.body.appendChild(region)

    // Authored `overflow-y: auto` — a genuine scroll container, correctly found.
    expect(collectScrollDeficits(document)).toEqual([240])

    // CanvasScrollUnrollInjector's `!important` blanket rule wins the cascade.
    region.style.overflowY = 'visible'

    // The region is now invisible to the scan. This is the open bug, asserted
    // as-is so a future fix has to change this line consciously.
    expect(collectScrollDeficits(document)).toEqual([])
  })

  it('ignores a sub-pixel mismatch regardless of overflow value', () => {
    const el = document.createElement('div')
    stubBox(el, { scrollHeight: 400.6, clientHeight: 400 })
    document.body.appendChild(el)

    expect(collectScrollDeficits(document)).toEqual([])
  })

  it('takes every qualifying descendant, letting resolveFrameFitHeight pick the worst', () => {
    const shallow = document.createElement('div')
    shallow.style.overflowY = 'scroll'
    stubBox(shallow, { scrollHeight: 850, clientHeight: 800 })
    const deep = document.createElement('div')
    deep.style.overflowY = 'auto'
    stubBox(deep, { scrollHeight: 1200, clientHeight: 500 })
    const hiddenSibling = document.createElement('div')
    hiddenSibling.style.overflowY = 'hidden'
    stubBox(hiddenSibling, { scrollHeight: 5000, clientHeight: 100 })
    // Visible overflow is painted, not hidden — never a deficit.
    const visibleSibling = document.createElement('div')
    stubBox(visibleSibling, { scrollHeight: 9000, clientHeight: 100 })

    document.body.append(shallow, deep, hiddenSibling, visibleSibling)

    const deficits = collectScrollDeficits(document)
    expect(deficits.sort((a, b) => a - b)).toEqual([50, 700])
  })
})
