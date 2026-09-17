/**
 * The ghost a smart animate flies, and what happens to it afterwards.
 *
 * WHICH elements pair is tested purely in `@core/studio-prototype`. What is
 * tested here is the part that has to be true about the DOM: a ghost is a
 * parent-document box painted from the incoming element, it is positioned at
 * its DESTINATION so the last frame needs no fill-forward, and nothing it
 * creates outlives the transition — a box left on screen after a navigation is
 * the failure mode this whole mechanism is chosen to avoid.
 */
import { describe, expect, it } from 'bun:test'
import { createGhostElement, runSmartAnimate, type SmartAnimateGhost } from '@site/canvas/smartAnimateFlip'

function ghost(overrides: Partial<SmartAnimateGhost> = {}): SmartAnimateGhost {
  return {
    from: { left: 0, top: 200, width: 100, height: 40 },
    to: { left: 24, top: 8, width: 320, height: 56 },
    paint: {
      background: 'rgb(10, 20, 30)',
      borderRadius: '12px',
      border: '',
      boxShadow: '',
      color: 'rgb(255, 255, 255)',
      font: '600 18px/24px Inter',
      letterSpacing: 'normal',
      textAlign: 'start',
      text: 'Almosafer',
    },
    ...overrides,
  }
}

describe('a ghost', () => {
  it('is placed at the destination, not the origin', () => {
    const element = createGhostElement(document, ghost())
    expect(element.style.left).toBe('24px')
    expect(element.style.top).toBe('8px')
    expect(element.style.width).toBe('320px')
    expect(element.style.height).toBe('56px')
  })

  it('carries the incoming element own paint, and its text when it draws text', () => {
    const element = createGhostElement(document, ghost())
    expect(element.style.borderRadius).toBe('12px')
    expect(element.textContent).toBe('Almosafer')
    // It is decoration over a real screen that is already accessible.
    expect(element.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws no text for a box that only contains other elements', () => {
    const element = createGhostElement(document, ghost({ paint: { ...ghost().paint, text: '' } }))
    expect(element.textContent).toBe('')
  })
})

describe('running the travel', () => {
  it('leaves nothing behind on an engine with no Web Animations API', () => {
    // happy-dom is such an engine, which is exactly the assertion: the screen
    // simply appears, and no ghost is stranded over it.
    const layer = document.createElement('div')
    document.body.appendChild(layer)

    runSmartAnimate(layer, [ghost(), ghost()], 480)

    expect(layer.querySelectorAll('[data-smart-animate-ghost]')).toHaveLength(0)
    layer.remove()
  })

  it('cleans up when the caller cancels mid-transition', () => {
    const layer = document.createElement('div')
    document.body.appendChild(layer)

    const stop = runSmartAnimate(layer, [ghost()], 480)
    stop()

    expect(layer.querySelectorAll('[data-smart-animate-ghost]')).toHaveLength(0)
    layer.remove()
  })
})
