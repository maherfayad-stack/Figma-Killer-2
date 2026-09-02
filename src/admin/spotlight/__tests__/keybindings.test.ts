import { describe, expect, it } from 'bun:test'
import { getKeybindingForCommand, type KeyEventLike } from '../keybindings'

function key(overrides: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

describe('D2/D3 keybindings — canvas.zoomToFit / canvas.zoomToSelection / layers.moveUp / layers.moveDown', () => {
  it('canvas.zoomToFit matches plain Shift+1 only', () => {
    const binding = getKeybindingForCommand('canvas.zoomToFit')
    expect(binding).toBeDefined()
    expect(binding!.match(key({ key: '1', shiftKey: true }))).toBe(true)
    // Not Cmd/Ctrl+0's territory, not a bare '1', not Alt/Meta/Ctrl combined.
    expect(binding!.match(key({ key: '1' }))).toBe(false)
    expect(binding!.match(key({ key: '1', shiftKey: true, metaKey: true }))).toBe(false)
    expect(binding!.match(key({ key: '1', shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(binding!.match(key({ key: '1', shiftKey: true, altKey: true }))).toBe(false)
  })

  it('canvas.zoomToSelection matches plain Shift+2 only, and is distinct from zoomToFit', () => {
    const binding = getKeybindingForCommand('canvas.zoomToSelection')
    expect(binding).toBeDefined()
    expect(binding!.match(key({ key: '2', shiftKey: true }))).toBe(true)
    expect(binding!.match(key({ key: '1', shiftKey: true }))).toBe(false)
    const fitBinding = getKeybindingForCommand('canvas.zoomToFit')!
    expect(fitBinding.match(key({ key: '2', shiftKey: true }))).toBe(false)
  })

  it('layers.moveUp / layers.moveDown match Alt+ArrowUp / Alt+ArrowDown, and only those', () => {
    const up = getKeybindingForCommand('layers.moveUp')
    const down = getKeybindingForCommand('layers.moveDown')
    expect(up).toBeDefined()
    expect(down).toBeDefined()

    expect(up!.match(key({ key: 'ArrowUp', altKey: true }))).toBe(true)
    expect(down!.match(key({ key: 'ArrowDown', altKey: true }))).toBe(true)

    // Not each other.
    expect(up!.match(key({ key: 'ArrowDown', altKey: true }))).toBe(false)
    expect(down!.match(key({ key: 'ArrowUp', altKey: true }))).toBe(false)

    // A bare arrow (no Alt) must NOT match — that's reserved for a future
    // sibling-navigation shortcut and must stay a no-op today.
    expect(up!.match(key({ key: 'ArrowUp' }))).toBe(false)

    // Meta/Ctrl/Shift combined with Alt+Arrow must not match — keeps this
    // binding from also firing under some other modifier combo a future
    // shortcut might want.
    expect(up!.match(key({ key: 'ArrowUp', altKey: true, metaKey: true }))).toBe(false)
    expect(up!.match(key({ key: 'ArrowUp', altKey: true, shiftKey: true }))).toBe(false)
  })
})
