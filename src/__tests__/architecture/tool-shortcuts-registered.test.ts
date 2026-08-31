/**
 * The three bare-letter tool keys — `T`, `F`, `C` — are registered bindings,
 * and each rejects every modifier.
 *
 * Bare letters are the highest-risk shortcuts in the app. A modifier-carrying
 * combo is unlikely to collide with anything; a bare `c` collides with typing
 * the letter c, and a `c` that forgets to check `metaKey` steals ⌘C from copy.
 * The comment tool shipped with exactly that hazard — a private `window`
 * keydown listener inside `CommentToolButton` with its own hand-rolled typing
 * guard — which is the drift `keybindings-registry-single-source.test.ts`
 * exists to stop, but which that gate did not catch because it only greps for
 * combos that carry a meta/ctrl modifier.
 *
 * This is the missing half: bare-letter tool keys must come from the registry,
 * so there is one guard, one help-screen entry, and one place to change them.
 */
import { describe, it, expect } from 'bun:test'
import { getKeybindingForCommand, type KeyEventLike } from '@admin/spotlight/keybindings'

const TOOL_KEYS: ReadonlyArray<{ commandId: string; key: string }> = [
  { commandId: 'tools.text', key: 't' },
  { commandId: 'tools.frame', key: 'f' },
  { commandId: 'tools.comment', key: 'c' },
]

const event = (over: Partial<KeyEventLike>): KeyEventLike => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: 'x',
  ...over,
})

describe('bare-letter tool shortcuts', () => {
  it.each(TOOL_KEYS)('$commandId is registered and matches its bare letter', ({ commandId, key }) => {
    const binding = getKeybindingForCommand(commandId)
    expect(binding).toBeDefined()
    expect(binding!.match(event({ key }))).toBe(true)
    // Upper case too — a reviewer with caps lock on is still pressing the key.
    expect(binding!.match(event({ key: key.toUpperCase() }))).toBe(true)
  })

  it.each(TOOL_KEYS)('$commandId ignores every modifier', ({ commandId, key }) => {
    const binding = getKeybindingForCommand(commandId)!
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      expect(`${modifier}: ${binding.match(event({ key, [modifier]: true }))}`).toBe(
        `${modifier}: false`,
      )
    }
  })

  it.each(TOOL_KEYS)('$commandId stands down inside a text field', ({ commandId }) => {
    // Advisory on the binding, enforced by the handler — but if the flag is
    // ever dropped the handler's own guard is the only thing left, and the
    // next person to read the registry will believe typing is safe.
    expect(getKeybindingForCommand(commandId)!.ignoreInEditableField).toBe(true)
  })

  it('no two tool keys claim the same letter', () => {
    const letters = TOOL_KEYS.map((entry) => entry.key)
    expect(new Set(letters).size).toBe(letters.length)
  })
})
