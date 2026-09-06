/**
 * The stdin wire format, pinned to what the W4-2B spike observed the real
 * binary accept. Every expectation here is a transcription of a line that was
 * actually fed to `claude 2.1.263` and answered — not a guess at a schema.
 *
 * If one of these fails, the fix is to re-run the spike (see
 * `claudeCliStdinProtocol.ts`'s doc comment) and update BOTH the module doc
 * and this file, never to loosen the assertion.
 */
import { describe, expect, it } from 'bun:test'
import { buildControlRequestLine, buildUserMessageLine, encodeStdinLine } from './claudeCliStdinProtocol'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('buildUserMessageLine', () => {
  it('produces the exact envelope the CLI accepted in the spike', () => {
    expect(buildUserMessageLine('Say only: OK')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Say only: OK' }] },
      parent_tool_use_id: null,
    })
  })

  it('serialises to the byte-for-byte line that was fed to the binary', () => {
    expect(decode(encodeStdinLine(buildUserMessageLine('Say only: OK')))).toBe(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say only: OK"}]},"parent_tool_use_id":null}\n',
    )
  })

  it('sends no session id — the CLI stamps its own and ignores anything sent', () => {
    expect(decode(encodeStdinLine(buildUserMessageLine('hi')))).not.toContain('session_id')
  })
})

describe('encodeStdinLine', () => {
  it('emits exactly one trailing newline and no others — malformed stdin kills the process', () => {
    const line = decode(encodeStdinLine(buildUserMessageLine('first\nsecond\n\nthird')))
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
  })

  it('escapes a multi-line prompt rather than splitting it across frames', () => {
    const line = decode(encodeStdinLine(buildUserMessageLine('a\nb')))
    expect(line).toContain('"text":"a\\nb"')
    // The whole point: this is what argv could never do safely on Windows.
    expect(JSON.parse(line).message.content[0].text).toBe('a\nb')
  })

  it('round-trips control characters and unicode without producing a second line', () => {
    const text = 'tab\there\r\ncarriage — emoji 🎨 "quoted" \\backslash'
    const line = decode(encodeStdinLine(buildUserMessageLine(text)))
    expect(line.split('\n')).toHaveLength(2)
    expect(JSON.parse(line).message.content[0].text).toBe(text)
  })
})

describe('buildControlRequestLine', () => {
  it('builds the interrupt frame that cancelled a live turn in the spike', () => {
    expect(decode(encodeStdinLine(buildControlRequestLine('studio-1', { subtype: 'interrupt' })))).toBe(
      '{"type":"control_request","request_id":"studio-1","request":{"subtype":"interrupt"}}\n',
    )
  })

  it('echoes the request id back to the caller, which is how responses are matched', () => {
    expect(buildControlRequestLine('studio-42', { subtype: 'interrupt' })).toEqual({
      type: 'control_request',
      request_id: 'studio-42',
      request: { subtype: 'interrupt' },
    })
  })
})
