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
 * The rule under test: the board is the unit of "a document opened" when there is
 * one, the page otherwise, and each unit is framed at most once.
 */
import { describe, expect, it } from 'bun:test'
import { resolveCanvasFocusTarget } from '@site/canvas/canvasFocusTarget'

describe('resolveCanvasFocusTarget — board mode', () => {
  it('frames the board once when it opens', () => {
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: 'board-1',
        canvasPageId: 'home',
        lastCenteredKey: null,
      }),
    ).toEqual({ centerKey: 'board-1', shouldCenter: true })
  })

  it('does NOT re-frame when selection moves the active page within the same board', () => {
    // This is the regression. `canvasPageId` changed from `home` to `checkout`
    // purely because the user clicked an element in another frame.
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: 'board-1',
        canvasPageId: 'checkout',
        lastCenteredKey: 'board-1',
      }),
    ).toEqual({ centerKey: 'board-1', shouldCenter: false })
  })

  it('does NOT re-frame no matter how many times the page changes', () => {
    for (const canvasPageId of ['a', 'b', 'c', 'a']) {
      expect(
        resolveCanvasFocusTarget({
          activeBoardId: 'board-1',
          canvasPageId,
          lastCenteredKey: 'board-1',
        }).shouldCenter,
      ).toBe(false)
    }
  })

  it('frames again when a DIFFERENT board is opened', () => {
    expect(
      resolveCanvasFocusTarget({
        activeBoardId: 'board-2',
        canvasPageId: 'home',
        lastCenteredKey: 'board-1',
      }),
    ).toEqual({ centerKey: 'board-2', shouldCenter: true })
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
