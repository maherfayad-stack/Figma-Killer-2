/**
 * IX-18 — the W×H badge reads the SAME rect the selection ring and the resize
 * handles were placed on, in the overlay's write phase, and only while a drag
 * marks the handle frame.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { positionResizeFrame } from '@site/canvas/canvasSelectionOverlayPositioning'
import { RESIZE_ACTIVE_ATTR, RESIZE_SIZE_BADGE_ATTR } from '@core/studio-runtime'

function handleFrame(): { frame: HTMLElement; badge: HTMLElement } {
  const frame = document.createElement('div')
  const badge = document.createElement('div')
  badge.setAttribute(RESIZE_SIZE_BADGE_ATTR, 'true')
  frame.appendChild(badge)
  document.body.appendChild(frame)
  return { frame, badge }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('positionResizeFrame', () => {
  it('places the frame on the ring rect and leaves the badge alone when no drag is live', () => {
    const { frame, badge } = handleFrame()
    positionResizeFrame(frame, { x: 10, y: 20, width: 120.4, height: 60.6 })
    expect(frame.style.width).toBe('120.4px')
    expect(badge.textContent).toBe('')
  })

  it('writes the rounded frame-px size while a drag marks the frame', () => {
    const { frame, badge } = handleFrame()
    frame.setAttribute(RESIZE_ACTIVE_ATTR, 'true')
    positionResizeFrame(frame, { x: 10, y: 20, width: 120.4, height: 60.6 })
    expect(badge.textContent).toBe('120 × 61')
    positionResizeFrame(frame, { x: 10, y: 20, width: 180, height: 61 })
    expect(badge.textContent).toBe('180 × 61')
  })
})
