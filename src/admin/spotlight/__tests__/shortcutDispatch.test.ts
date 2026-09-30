import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { getKeybindingForCommand } from '../keybindings'
import { findMatchingShortcutCommand } from '../shortcutDispatch'
import type { CommandContext } from '../types'

const SPOTLIGHT_ROOT = new URL('../SpotlightRoot.tsx', import.meta.url)

function eventLike(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }
}

function context(capabilities: string[], editor?: CommandContext['editor']): CommandContext {
  return {
    workspace: 'site',
    pathname: '/admin/site',
    user: {
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
      roleId: 'role-owner',
      roleName: 'Owner',
      capabilities,
    },
    editor,
  } as CommandContext
}

function canvasTarget() {
  return {
    tagName: 'DIV',
    isContentEditable: false,
    closest: (selector: string) =>
      selector === '[data-studio-canvas-root="true"]' ? {} : null,
  }
}

function layerTreeTarget() {
  return {
    tagName: 'DIV',
    isContentEditable: false,
    closest: (selector: string) =>
      selector === '[data-studio-layer-tree="true"]' ? {} : null,
  }
}

describe('command shortcut dispatch', () => {
  it('registers Cmd/Ctrl+I for opening the AI assistant panel', () => {
    const binding = getKeybindingForCommand('ai.open')

    expect(binding).toBeDefined()
    expect(binding?.shortcut).toEqual({ mac: '⌘I', win: 'Ctrl+I' })
    expect(binding?.scope).toBe('panels')
    expect(binding?.match(eventLike('i', { metaKey: true }))).toBe(true)
    expect(binding?.match(eventLike('i', { ctrlKey: true }))).toBe(true)
  })

  it('SpotlightRoot dispatches registered command shortcuts beyond Cmd+K', () => {
    const src = readFileSync(SPOTLIGHT_ROOT, 'utf-8')

    expect(src).toContain('findMatchingShortcutCommand')
    expect(src).toContain('void runCommand(shortcutCommand)')
  })

  it('resolves Cmd/Ctrl+I to the AI command only when ai.chat is available', () => {
    const allowed = findMatchingShortcutCommand(
      eventLike('i', { metaKey: true }) as KeyboardEvent,
      context(['site.read', 'ai.chat']),
    )
    const denied = findMatchingShortcutCommand(
      eventLike('i', { metaKey: true }) as KeyboardEvent,
      context(['site.read']),
    )

    expect(allowed?.id).toBe('ai.open')
    expect(denied).toBeNull()
  })

  // P5-A — ⌘C / ⌘X / ⌘V are the canvas `node` rung's (`useCanvasNodeShortcuts`),
  // which must let the keystroke through so the browser raises the `copy` /
  // `paste` EVENT the clipboard bridge reads. Resolved here, this capture-phase
  // listener `preventDefault`ed them first and the event never fired.
  it('leaves ⌘C / ⌘X / ⌘V to the canvas node rung, from the canvas and the Layers tree, in either key case', () => {
    const ctx = context(['site.read', 'site.structure.edit'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    })
    for (const target of [canvasTarget(), layerTreeTarget()]) {
      for (const key of ['c', 'x', 'v', 'C', 'X', 'V']) {
        const command = findMatchingShortcutCommand(
          eventLike(key, { metaKey: true, target: target as EventTarget }) as KeyboardEvent,
          ctx,
        )
        expect(command?.id).toBeUndefined()
      }
    }
  })

  it('registers Cmd/Ctrl+Backspace for deleting the selected layer', () => {
    const binding = getKeybindingForCommand('layers.delete')

    expect(binding).toBeDefined()
    expect(binding?.shortcut).toEqual({ mac: '⌘⌫', win: 'Ctrl+Backspace' })
    expect(binding?.match(eventLike('Backspace', { metaKey: true }))).toBe(true)
    expect(binding?.match(eventLike('Backspace', { ctrlKey: true }))).toBe(true)
  })

  it('does not run canvas shortcuts during inline text editing', () => {
    const ctx = context(['site.read', 'site.structure.edit'], {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: true,
    })

    // ⇧K (`insert.image`) is a canvas-scoped shortcut this dispatcher DOES
    // resolve (see the next test); ⌘C no longer is one (P5-A, above).
    const command = findMatchingShortcutCommand(
      eventLike('K', { shiftKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent,
      ctx,
    )

    expect(command).toBeNull()
  })

  it('resolves ⇧K on the canvas to the `insert.image` command from P5-B (the binding names a command that exists)', () => {
    const editor: CommandContext['editor'] = {
      selectedNodeIds: ['node-1'],
      activePageId: 'page-1',
      activeDocument: { kind: 'page', pageId: 'page-1' },
      canUndo: false,
      canRedo: false,
      activeBreakpointId: 'desktop',
      activeInlineEdit: false,
    }
    const press = eventLike('K', { shiftKey: true, target: canvasTarget() as EventTarget }) as KeyboardEvent

    expect(findMatchingShortcutCommand(press, context(['site.read', 'site.structure.edit'], editor))?.id)
      .toBe('insert.image')
    // Inserting is a structural edit: a read-only session gets nothing.
    expect(findMatchingShortcutCommand(press, context(['site.read'], editor))).toBeNull()
  })
})
