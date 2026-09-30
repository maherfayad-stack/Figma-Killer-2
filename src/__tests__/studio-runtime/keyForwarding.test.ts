/**
 * P2-B — the in-frame half of a Tier 2 bridge frame's keyboard
 * (`keyForwarding.ts`), driven through the real `createStudioRuntimeBridge`
 * so the wire envelope and its schema check are part of what is tested.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { createStudioRuntimeBridge, OutboundEnvelopeSchema, type StudioRuntimeBridge } from '@core/studio-runtime'

const PARENT_ORIGIN = 'https://parent.test'

let bridge: StudioRuntimeBridge | null = null

afterEach(() => {
  bridge?.dispose()
  bridge = null
  document.body.innerHTML = ''
})

function boot(mode: 'design' | 'live') {
  const posted: unknown[] = []
  const fakeWindow = { postMessage: (data: unknown) => posted.push(data) } as unknown as Window
  bridge = createStudioRuntimeBridge({ parentOrigin: PARENT_ORIGIN, parentWindow: fakeWindow, document })
  bridge.handleMessage({ type: 'setMode', mode })
  const messages = () =>
    posted
      .filter((data) => Value.Check(OutboundEnvelopeSchema, data))
      .map((data) => (data as { message: { type: string } & Record<string, unknown> }).message)
  return { messages }
}

function keydown(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('keyForwarding — design mode', () => {
  it('posts a keydown and a keyup as schema-valid `key` messages, and cancels the frame default', () => {
    const { messages } = boot('design')
    const event = keydown(document.body, { key: 'Tab', code: 'Tab', shiftKey: true })
    document.body.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab', code: 'Tab' }))

    const keys = messages().filter((m) => m.type === 'key')
    expect(keys).toEqual([
      { type: 'key', phase: 'down', key: 'Tab', code: 'Tab', location: 0, repeat: false, modifiers: { shiftKey: true, altKey: false, ctrlKey: false, metaKey: false } },
      { type: 'key', phase: 'up', key: 'Tab', code: 'Tab', location: 0, repeat: false, modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } },
    ])
    // No Tab walk through the app's links on a design frame.
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves typing alone: a contentEditable (an inline edit) and a text field', () => {
    const { messages } = boot('design')
    const editable = document.createElement('p')
    editable.setAttribute('contenteditable', 'plaintext-only')
    const field = document.createElement('input')
    document.body.append(editable, field)

    const inEdit = keydown(editable, { key: 'Backspace', code: 'Backspace' })
    const inField = keydown(field, { key: 'a', code: 'KeyA' })

    expect(messages().filter((m) => m.type === 'key')).toEqual([])
    expect(inEdit.defaultPrevented).toBe(false)
    expect(inField.defaultPrevented).toBe(false)
  })

  it('posts `blur` when the frame window loses focus', () => {
    const { messages } = boot('design')
    window.dispatchEvent(new Event('blur'))
    expect(messages().filter((m) => m.type === 'blur')).toEqual([{ type: 'blur' }])
  })
})

describe('keyForwarding — live mode', () => {
  it('posts nothing and cancels nothing: the page is the visitor\'s', () => {
    const { messages } = boot('live')
    const event = keydown(document.body, { key: 'Tab', code: 'Tab' })
    window.dispatchEvent(new Event('blur'))

    expect(messages().filter((m) => m.type === 'key' || m.type === 'blur')).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })
})
