/**
 * The gesture freeze, and the settle pass that makes it safe.
 *
 * The failure this guards against is not a wrong pixel — it is geometry that
 * was deliberately not recomputed during a drag and then never recomputed
 * after it, leaving the frame fit and the toolbar anchor permanently stale.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import {
  beginCanvasGesture,
  endCanvasGesture,
  isCanvasGestureActive,
  onCanvasGestureSettle,
} from '@site/canvas/canvasGesture'

afterEach(() => {
  // Module-level state: leave it clean or the next test inherits a frozen canvas.
  endCanvasGesture(beginCanvasGesture())
})

describe('canvasGesture', () => {
  it('is inactive until a gesture begins, and inactive again after it ends', () => {
    expect(isCanvasGestureActive()).toBe(false)
    const token = beginCanvasGesture()
    expect(isCanvasGestureActive()).toBe(true)
    endCanvasGesture(token)
    expect(isCanvasGestureActive()).toBe(false)
  })

  it('ignores an end from a token that did not begin the active gesture', () => {
    // A listener torn down mid-drag must not be able to unfreeze geometry
    // underneath the gesture that is still running.
    const stale = beginCanvasGesture()
    const current = beginCanvasGesture()
    endCanvasGesture(stale)
    expect(isCanvasGestureActive()).toBe(true)
    endCanvasGesture(current)
    expect(isCanvasGestureActive()).toBe(false)
  })

  it('runs settle listeners exactly once, when the gesture ends', () => {
    let settles = 0
    const release = onCanvasGestureSettle(() => { settles += 1 })

    const token = beginCanvasGesture()
    expect(settles).toBe(0) // nothing recomputes DURING the gesture
    endCanvasGesture(token)
    expect(settles).toBe(1)

    release()
  })

  it('reports inactive to a settle listener, so its recompute is not skipped', () => {
    // The whole point: the listener's own work is usually guarded by
    // `isCanvasGestureActive()`, so the flag must already be cleared when it runs.
    let sawActive: boolean | null = null
    const release = onCanvasGestureSettle(() => { sawActive = isCanvasGestureActive() })
    endCanvasGesture(beginCanvasGesture())
    expect(sawActive).toBe(false)
    release()
  })

  it('stops calling a released listener', () => {
    let settles = 0
    const release = onCanvasGestureSettle(() => { settles += 1 })
    release()
    endCanvasGesture(beginCanvasGesture())
    expect(settles).toBe(0)
  })

  it('does not run settle listeners for an ignored stale end', () => {
    let settles = 0
    const release = onCanvasGestureSettle(() => { settles += 1 })
    const stale = beginCanvasGesture()
    const current = beginCanvasGesture()
    endCanvasGesture(stale)
    expect(settles).toBe(0)
    endCanvasGesture(current)
    expect(settles).toBe(1)
    release()
  })
})
