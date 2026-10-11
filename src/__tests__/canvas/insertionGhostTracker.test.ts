import { describe, expect, it } from 'bun:test'
import { createInsertionGhostTracker } from '@site/canvas/insertionGhostTracker'
import { ghostPositionStyle } from '@site/canvas/CanvasInsertionDragOverlay/ghostPositionStyle'

function fakeElement() {
  const props = new Map<string, string>()
  const element = { style: { setProperty: (name: string, value: string) => void props.set(name, value) } }
  return { element: element as unknown as HTMLElement, props }
}

describe('insertionGhostTracker', () => {
  it('writes the pointer straight to the element, with no render in between', () => {
    const { element, props } = fakeElement()
    const tracker = createInsertionGhostTracker(10, 20)
    tracker.attach(element)
    expect(props.get('--ghost-x')).toBe('10px')
    expect(props.get('--ghost-y')).toBe('20px')
    tracker.moveTo(300, 140)
    expect(props.get('--ghost-x')).toBe('300px')
    expect(props.get('--ghost-y')).toBe('140px')
  })

  it('applies the latest point when the element mounts after the first moves', () => {
    const tracker = createInsertionGhostTracker(0, 0)
    tracker.moveTo(55, 66)
    const { element, props } = fakeElement()
    tracker.attach(element)
    expect(props.get('--ghost-x')).toBe('55px')
    expect(props.get('--ghost-y')).toBe('66px')
  })

  it('stops writing once the element is detached', () => {
    const { element, props } = fakeElement()
    const tracker = createInsertionGhostTracker(1, 2)
    tracker.attach(element)
    tracker.attach(null)
    tracker.moveTo(9, 9)
    expect(props.get('--ghost-x')).toBe('1px')
  })
})

describe('ghostPositionStyle', () => {
  it('leaves the position to the tracker, and carries only size and zoom', () => {
    const style = ghostPositionStyle({ x: 5, y: 6, tracker: {}, size: { width: 100, height: 40 }, zoom: 0.41 }) as Record<string, string>
    expect(style['--ghost-x']).toBeUndefined()
    expect(style['--ghost-w']).toBe('100px')
    expect(style['--ghost-h']).toBe('40px')
    expect(style['--ghost-zoom']).toBe('0.41')
  })

  it('positions a caller that re-renders per move from its own point', () => {
    const style = ghostPositionStyle({ x: 5, y: 6 }) as Record<string, string>
    expect(style['--ghost-x']).toBe('5px')
    expect(style['--ghost-y']).toBe('6px')
  })
})
