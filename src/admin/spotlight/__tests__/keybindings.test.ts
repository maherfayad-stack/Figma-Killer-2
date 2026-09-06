import { describe, expect, it } from 'bun:test'
import {
  KEYBINDINGS,
  frameNudgeDelta,
  getKeybindingForCommand,
  FRAME_NUDGE_STEP,
  FRAME_NUDGE_STEP_LARGE,
  type KeyEventLike,
} from '../keybindings'

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

    // A bare arrow (no Alt) must NOT match. It now belongs to
    // `board.nudgeFrames` while board frames are selected (viewport-01), and
    // is still free for a future sibling-navigation shortcut with a NODE
    // selected — either way this binding must not claim it.
    expect(up!.match(key({ key: 'ArrowUp' }))).toBe(false)

    // Meta/Ctrl/Shift combined with Alt+Arrow must not match — keeps this
    // binding from also firing under some other modifier combo a future
    // shortcut might want.
    expect(up!.match(key({ key: 'ArrowUp', altKey: true, metaKey: true }))).toBe(false)
    expect(up!.match(key({ key: 'ArrowUp', altKey: true, shiftKey: true }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// viewport-01 — zoom reset, selection traversal, rename/visibility, frame nudge
// ---------------------------------------------------------------------------

describe('viewport-01 keybindings', () => {
  it('canvas.zoomReset matches Cmd/Ctrl+0 only', () => {
    const binding = getKeybindingForCommand('canvas.zoomReset')!
    expect(binding).toBeDefined()
    expect(binding.match(key({ key: '0', metaKey: true }))).toBe(true)
    expect(binding.match(key({ key: '0', ctrlKey: true }))).toBe(true)
    // A bare 0, and 0 under Shift/Alt, belong to other things (or to nothing).
    expect(binding.match(key({ key: '0' }))).toBe(false)
    expect(binding.match(key({ key: '0', metaKey: true, shiftKey: true }))).toBe(false)
    expect(binding.match(key({ key: '0', metaKey: true, altKey: true }))).toBe(false)
  })

  it('Enter selects the first child, Shift+Enter the parent — never each other', () => {
    const child = getKeybindingForCommand('layers.selectFirstChild')!
    const parent = getKeybindingForCommand('layers.selectParent')!

    expect(child.match(key({ key: 'Enter' }))).toBe(true)
    expect(child.match(key({ key: 'Enter', shiftKey: true }))).toBe(false)

    expect(parent.match(key({ key: 'Enter', shiftKey: true }))).toBe(true)
    expect(parent.match(key({ key: 'Enter' }))).toBe(false)

    // Neither claims a modified Enter that belongs elsewhere (Cmd/Alt+Enter).
    for (const binding of [child, parent]) {
      expect(binding.match(key({ key: 'Enter', metaKey: true }))).toBe(false)
      expect(binding.match(key({ key: 'Enter', ctrlKey: true }))).toBe(false)
      expect(binding.match(key({ key: 'Enter', altKey: true }))).toBe(false)
    }
  })

  it('Escape is NOT bound to selection traversal — it stays the deselect ladder', () => {
    // `select-01` shipped "Escape clears everything" to fix a reported
    // "I can't deselect" bug. viewport-01 deliberately did not re-point it at
    // "select parent"; if a future change wants to, this assertion is the
    // conversation it has to have first.
    for (const binding of KEYBINDINGS) {
      expect(binding.match(key({ key: 'Escape' }))).toBe(false)
    }
  })

  it('layers.rename is Cmd/Ctrl+R and layers.toggleVisibility is Cmd/Ctrl+Shift+H', () => {
    const rename = getKeybindingForCommand('layers.rename')!
    expect(rename.match(key({ key: 'r', metaKey: true }))).toBe(true)
    expect(rename.match(key({ key: 'R', ctrlKey: true }))).toBe(true)
    expect(rename.match(key({ key: 'r' }))).toBe(false)
    expect(rename.match(key({ key: 'r', metaKey: true, shiftKey: true }))).toBe(false)

    const hide = getKeybindingForCommand('layers.toggleVisibility')!
    expect(hide.match(key({ key: 'h', metaKey: true, shiftKey: true }))).toBe(true)
    expect(hide.match(key({ key: 'h', ctrlKey: true, shiftKey: true }))).toBe(true)
    // Plain Cmd+H is macOS "hide the window" — never ours.
    expect(hide.match(key({ key: 'h', metaKey: true }))).toBe(false)
  })

  it('board.nudgeFrames claims bare arrows (and Shift+arrows), never Alt+arrows', () => {
    const nudge = getKeybindingForCommand('board.nudgeFrames')!
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(nudge.match(key({ key: k }))).toBe(true)
      expect(nudge.match(key({ key: k, shiftKey: true }))).toBe(true)
      // Alt+arrow stays `layers.moveUp`/`layers.moveDown` (G12).
      expect(nudge.match(key({ key: k, altKey: true }))).toBe(false)
      expect(nudge.match(key({ key: k, metaKey: true }))).toBe(false)
      expect(nudge.match(key({ key: k, ctrlKey: true }))).toBe(false)
    }
    expect(nudge.match(key({ key: 'Enter' }))).toBe(false)
  })

  it('frameNudgeDelta decodes direction and the Shift step', () => {
    expect(frameNudgeDelta(key({ key: 'ArrowLeft' }))).toEqual({ dx: -FRAME_NUDGE_STEP, dy: 0 })
    expect(frameNudgeDelta(key({ key: 'ArrowRight' }))).toEqual({ dx: FRAME_NUDGE_STEP, dy: 0 })
    expect(frameNudgeDelta(key({ key: 'ArrowUp' }))).toEqual({ dx: 0, dy: -FRAME_NUDGE_STEP })
    expect(frameNudgeDelta(key({ key: 'ArrowDown' }))).toEqual({ dx: 0, dy: FRAME_NUDGE_STEP })

    expect(frameNudgeDelta(key({ key: 'ArrowDown', shiftKey: true })))
      .toEqual({ dx: 0, dy: FRAME_NUDGE_STEP_LARGE })
    expect(frameNudgeDelta(key({ key: 'Enter' }))).toBeNull()
  })

  it('every registry entry is unique by commandId — the lookup map keys on it', () => {
    const ids = KEYBINDINGS.map((kb) => kb.commandId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('no two bindings in the same scope claim the same keystroke', () => {
    // Guards the class of bug viewport-01 hit while adding Shift+Enter: an
    // existing handler matched a bare `event.key === 'Enter'` and swallowed
    // the new modified variant.
    const samples: KeyEventLike[] = [
      key({ key: 'Enter' }),
      key({ key: 'Enter', shiftKey: true }),
      key({ key: '0', metaKey: true }),
      key({ key: 'r', metaKey: true }),
      key({ key: 'h', metaKey: true, shiftKey: true }),
      key({ key: 'ArrowUp' }),
      key({ key: 'ArrowUp', altKey: true }),
      key({ key: 'ArrowUp', shiftKey: true }),
      key({ key: '1', shiftKey: true }),
      key({ key: '2', shiftKey: true }),
    ]
    for (const sample of samples) {
      const scopes = KEYBINDINGS.filter((kb) => kb.match(sample)).map((kb) => kb.scope)
      expect(new Set(scopes).size).toBe(scopes.length)
    }
  })
})
