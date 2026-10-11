/**
 * resolveCanvasFocusTarget — selecting must never re-frame the canvas.
 *
 * The reported bug: in studio board mode the canvas "kept running away" — every
 * time the user selected an element it snapped back to the first frame. Two
 * things combined. Clicking any element activates that element's page
 * (`BoardFramesLayer`'s `onPointerDownCapture` → `openPageInCanvas`), so the
 * active page changes on selection; and every board frame renders a
 * `BreakpointFrame` from `buildStudioBreakpoint`, which varies only `width`, so
 * they all share one breakpoint id and the centering query always resolves to the
 * first frame in DOM order.
 *
 * The rule under test, in two steps. The first fix made each unit framed at most
 * once (board, else page). That still left a hole: framing looks the frame up by
 * the STORE's active breakpoint id, and a board's frames carry the synthetic
 * `'studio'` id instead - so the lookup found nothing at open, and succeeded
 * only after the user's first press set `activeBreakpointId` to `'studio'`,
 * framing the board under that first selection (every frame jumped, ~340 px
 * and ~500 px on test4). A board is therefore never framed from here: its view
 * is the user's (or Shift+1).
 */
import { describe, expect, it } from 'bun:test'
import { resolveCanvasFocusTarget } from '@site/canvas/canvasFocusTarget'

describe('resolveCanvasFocusTarget — board mode', () => {
  it('never frames a board: not when it opens, and not when its first frame is pressed', () => {
    for (const lastCenteredKey of [null, 'board-1']) {
      expect(
        resolveCanvasFocusTarget({ activeBoardId: 'board-1', canvasPageId: 'home', lastCenteredKey }).shouldCenter,
      ).toBe(false)
    }
  })

  it('does NOT frame when selection moves the active page within the board', () => {
    // `canvasPageId` changes purely because the user pressed an element in another frame.
    for (const canvasPageId of ['home', 'checkout', 'a', 'b', 'c', 'a']) {
      expect(
        resolveCanvasFocusTarget({ activeBoardId: 'board-1', canvasPageId, lastCenteredKey: null }).shouldCenter,
      ).toBe(false)
    }
  })

  it('does not frame a DIFFERENT board either', () => {
    expect(
      resolveCanvasFocusTarget({ activeBoardId: 'board-2', canvasPageId: 'home', lastCenteredKey: 'board-1' }),
    ).toEqual({ centerKey: 'board-2', shouldCenter: false })
  })
})

describe('resolveCanvasFocusTarget — outside board mode', () => {
  it('still frames a real page switch', () => {
    // A CMS page ↔ page navigation is genuine, not a selection side effect.
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: null,
        canvasPageId: 'about',
        lastCenteredKey: 'home',
      }),
    ).toEqual({ centerKey: 'about', shouldCenter: true })
  })

  it('does not frame the same page twice', () => {
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: null,
        canvasPageId: 'home',
        lastCenteredKey: 'home',
      }).shouldCenter,
    ).toBe(false)
  })
})

describe('resolveCanvasFocusTarget — skeleton phase', () => {
  it('centers the skeleton and never records it as done', () => {
    // `canvasPageId` is null before the document arrives. Recording that as
    // "framed" would make the real document skip its own framing.
    const skeleton = resolveCanvasFocusTarget({
      activeBoardId: null,
      canvasPageId: null,
      lastCenteredKey: null,
    })
    expect(skeleton).toEqual({ centerKey: null, shouldCenter: true })

    // Still centers once the real page id lands.
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: null,
        canvasPageId: 'home',
        lastCenteredKey: null,
      }).shouldCenter,
    ).toBe(true)
  })

  it('re-centers on every skeleton re-run rather than latching', () => {
    // A null key can never equal itself here, by design — the retry loop owns
    // giving up, not this rule.
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: null,
        canvasPageId: null,
        lastCenteredKey: null,
      }).shouldCenter,
    ).toBe(true)
  })
})
