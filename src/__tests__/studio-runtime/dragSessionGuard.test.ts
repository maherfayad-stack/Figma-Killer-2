/**
 * ERR-12 — the shared drag-session guard.
 *
 * Two ways a drag used to be orphaned: the release landed in a document the
 * session never heard (a frame's iframe, outside the window), so the drag kept
 * following an un-pressed cursor; or the window lost focus mid-drag and the
 * gesture resumed against whatever the pointer did next.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { guardDragSession } from '@core/studio-runtime'

function move(target: EventTarget, buttons: number): Event {
  const event = new Event('pointermove', { bubbles: true, cancelable: true })
  Object.assign(event, { buttons, clientX: 10, clientY: 10, pointerId: 1 })
  target.dispatchEvent(event)
  return event
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('guardDragSession', () => {
  it('finishes the drag when a move arrives with the button up, passing that move', () => {
    const lost: Event[] = []
    let abandoned = 0
    const dispose = guardDragSession({
      documents: [document],
      focusWindow: window,
      onReleaseLost: (event) => lost.push(event),
      onAbandon: () => abandoned++,
    })
    move(document.body, 1)
    expect(lost).toHaveLength(0)
    const upMove = move(document.body, 0)
    expect(lost).toEqual([upMove])
    // Ended: nothing fires twice.
    move(document.body, 0)
    expect(lost).toHaveLength(1)
    expect(abandoned).toBe(0)
    dispose()
  })

  it('runs BEFORE a bubbling move handler on the same document, which never sees the orphaned move', () => {
    const seen: number[] = []
    const onMove = (event: Event) => seen.push((event as PointerEvent).buttons)
    document.addEventListener('pointermove', onMove)
    guardDragSession({
      documents: [document],
      focusWindow: window,
      onReleaseLost: () => document.removeEventListener('pointermove', onMove),
      onAbandon: () => {},
    })
    move(document.body, 1)
    move(document.body, 0)
    expect(seen).toEqual([1])
  })

  it('watches every document the drag can be delivered to', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const frameDoc = iframe.contentDocument!
    let lost = 0
    guardDragSession({ documents: [frameDoc], focusWindow: window, onReleaseLost: () => lost++, onAbandon: () => {} })
    move(frameDoc.body, 0)
    expect(lost).toBe(1)
  })

  it('abandons the drag when the window really lost focus', async () => {
    const hasFocus = spyOn(document, 'hasFocus').mockReturnValue(false)
    let abandoned = 0
    guardDragSession({ documents: [document], focusWindow: window, onReleaseLost: () => {}, onAbandon: () => abandoned++ })
    window.dispatchEvent(new Event('blur'))
    expect(abandoned).toBe(0) // only a hint until focus has settled
    await tick()
    expect(abandoned).toBe(1)
    hasFocus.mockRestore()
  })

  it('does NOT abandon when focus merely moved into a child frame', async () => {
    // The top-level document still has focus while a frame of it does.
    const hasFocus = spyOn(document, 'hasFocus').mockReturnValue(true)
    let abandoned = 0
    const dispose = guardDragSession({ documents: [document], focusWindow: window, onReleaseLost: () => {}, onAbandon: () => abandoned++ })
    window.dispatchEvent(new Event('blur'))
    await tick()
    expect(abandoned).toBe(0)
    dispose()
    hasFocus.mockRestore()
  })

  it('abandons when the document is hidden', () => {
    let abandoned = 0
    const dispose = guardDragSession({ documents: [document], focusWindow: window, onReleaseLost: () => {}, onAbandon: () => abandoned++ })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(abandoned).toBe(1)
    } finally {
      // Back to the prototype's own getter.
      delete (document as { visibilityState?: unknown }).visibilityState
      dispose()
    }
  })

  it('is inert once disposed', async () => {
    const hasFocus = spyOn(document, 'hasFocus').mockReturnValue(false)
    let calls = 0
    const dispose = guardDragSession({ documents: [document], focusWindow: window, onReleaseLost: () => calls++, onAbandon: () => calls++ })
    window.dispatchEvent(new Event('blur'))
    dispose()
    await tick()
    move(document.body, 0)
    expect(calls).toBe(0)
    hasFocus.mockRestore()
  })
})
