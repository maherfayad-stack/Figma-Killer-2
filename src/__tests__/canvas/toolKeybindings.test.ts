/**
 * `K4` — the bindings the editor was missing, and the collisions they could
 * have caused.
 *
 * Bare letters are the dangerous half of this work order: `H`, `K`, `R` and
 * `O` are one keystroke away from ⌘H (hide), ⌘K (spotlight), ⌘R (rename /
 * browser reload) and ⌘⇧L (lock). What separates them is nothing but a
 * modifier check inside each `match`, so these tests press the neighbours and
 * assert they are NOT claimed — a `match` that forgot a `!e.metaKey` passes
 * every behavioural test and then eats the palette.
 */
import { describe, it, expect } from 'bun:test'
import { getKeybindingForCommand, type KeyEventLike } from '@admin/spotlight/keybindings'

const base: KeyEventLike = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '' }

function press(patch: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ...base, ...patch }
}

function matches(commandId: string, event: KeyEventLike): boolean {
  const binding = getKeybindingForCommand(commandId)
  expect(binding).toBeDefined()
  return binding!.match(event)
}

describe('K4 — bracket reorder aliases', () => {
  it('⌘] moves up and ⌘[ moves down, on top of the ⌥↑/⌥↓ pair', () => {
    expect(matches('layers.moveUp', press({ metaKey: true, key: ']' }))).toBe(true)
    expect(matches('layers.moveUp', press({ ctrlKey: true, key: ']' }))).toBe(true)
    expect(matches('layers.moveDown', press({ metaKey: true, key: '[' }))).toBe(true)

    // The original binding is untouched — "keep both" is the requirement.
    expect(matches('layers.moveUp', press({ altKey: true, key: 'ArrowUp' }))).toBe(true)
    expect(matches('layers.moveDown', press({ altKey: true, key: 'ArrowDown' }))).toBe(true)
  })

  it('does not claim the bracket without a meta key, or with extra modifiers', () => {
    expect(matches('layers.moveUp', press({ key: ']' }))).toBe(false)
    expect(matches('layers.moveUp', press({ metaKey: true, shiftKey: true, key: ']' }))).toBe(false)
    expect(matches('layers.moveUp', press({ metaKey: true, altKey: true, key: ']' }))).toBe(false)
  })

  it('shows both keystrokes in the help sheet', () => {
    // A key the sheet never lists is a key nobody discovers — the alias is on
    // the binding precisely so `HelpKeybindingsList` can render it.
    expect(getKeybindingForCommand('layers.moveUp')?.aliasShortcut).toEqual({ mac: '⌘]', win: 'Ctrl+]' })
    expect(getKeybindingForCommand('layers.moveDown')?.aliasShortcut).toEqual({ mac: '⌘[', win: 'Ctrl+[' })
  })
})

describe('K4 — ⌘⇧L locks the layer', () => {
  it('claims ⌘⇧L and nothing near it', () => {
    expect(matches('layers.toggleLock', press({ metaKey: true, shiftKey: true, key: 'l' }))).toBe(true)
    expect(matches('layers.toggleLock', press({ ctrlKey: true, shiftKey: true, key: 'L' }))).toBe(true)
    // ⌘L is the browser's address bar; a bare `l` is a letter someone typed.
    expect(matches('layers.toggleLock', press({ metaKey: true, key: 'l' }))).toBe(false)
    expect(matches('layers.toggleLock', press({ key: 'l' }))).toBe(false)
  })

  it('is a real spotlight command id, so the generic dispatcher can run it', () => {
    // Deliberately handler-free: `layers.toggleLock` is argument-free and
    // non-destructive, so `shortcutDispatch.ts` runs it exactly as it runs
    // ⌘⇧H. A canvas handler would double-fire it.
    expect(getKeybindingForCommand('layers.toggleLock')?.displayName).toBeUndefined()
  })
})

describe('K4 — the bare tool letters', () => {
  const letters: ReadonlyArray<[commandId: string, key: string]> = [
    ['tools.hand', 'h'],
    ['tools.scale', 'k'],
    ['tools.rectangle', 'r'],
    ['tools.ellipse', 'o'],
  ]

  it('claims the plain letter, in either case', () => {
    for (const [commandId, key] of letters) {
      expect(matches(commandId, press({ key }))).toBe(true)
      expect(matches(commandId, press({ key: key.toUpperCase() }))).toBe(true)
    }
  })

  it('rejects EVERY modifier, so the neighbouring shortcuts survive', () => {
    for (const [commandId, key] of letters) {
      for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
        expect(matches(commandId, press({ [modifier]: true, key }))).toBe(false)
      }
    }
  })

  it('leaves the modified neighbours to their own owners', () => {
    // The four keystrokes a sloppy `match` here would have stolen.
    expect(matches('spotlight.open', press({ metaKey: true, key: 'k' }))).toBe(true)
    expect(matches('layers.rename', press({ metaKey: true, key: 'r' }))).toBe(true)
    expect(matches('layers.toggleVisibility', press({ metaKey: true, shiftKey: true, key: 'h' }))).toBe(true)
    expect(matches('layers.toggleLock', press({ metaKey: true, shiftKey: true, key: 'l' }))).toBe(true)
  })

  it('every tool letter stands down inside a text field', () => {
    // The whole reason a bare letter is safe to bind at all.
    for (const [commandId] of letters) {
      expect(getKeybindingForCommand(commandId)?.ignoreInEditableField).toBe(true)
    }
  })
})
