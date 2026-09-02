import { describe, expect, it } from 'bun:test'
import { normaliseToolOutput } from '../../../server/ai/drivers/http/execTool'

/**
 * Mirrors how drivers consume an `AiToolOutput` (see `toolOutputToString` in
 * responses-shared.ts): success serializes `data`, failure reads `error`.
 */
function consumeDownstream(output: ReturnType<typeof normaliseToolOutput>): string {
  if (!output.ok) return output.error ?? 'Tool call failed.'
  return JSON.stringify(output.data ?? { ok: true })
}

describe('normaliseToolOutput', () => {
  it('passes a well-formed success envelope through unchanged', () => {
    const out = normaliseToolOutput({ ok: true, data: { rows: [1, 2] } })
    expect(out).toEqual({ ok: true, data: { rows: [1, 2] } })
    expect(consumeDownstream(out)).toBe(JSON.stringify({ rows: [1, 2] }))
  })

  it('passes a well-formed error envelope through unchanged', () => {
    const out = normaliseToolOutput({ ok: false, error: 'boom' })
    expect(out).toEqual({ ok: false, error: 'boom' })
    expect(consumeDownstream(out)).toBe('boom')
  })

  it('treats { ok: false } without an error as a valid failure (not wrapped)', () => {
    // `error` is optional on the envelope, so this is a legitimate failure
    // result — wrapping it as success would flip a failure into a success.
    const out = normaliseToolOutput({ ok: false })
    expect(out.ok).toBe(false)
    expect(consumeDownstream(out)).toBe('Tool call failed.')
  })

  it('wraps a truthy-but-non-boolean { ok: 3 } instead of trusting it', () => {
    const out = normaliseToolOutput({ ok: 3 })
    // The old duck-type (`'ok' in result`) let this through, then `output.ok`
    // read as truthy. Validation rejects it and wraps the raw value as data.
    expect(out).toEqual({ ok: true, data: { ok: 3 } })
    expect(consumeDownstream(out)).toBe(JSON.stringify({ ok: 3 }))
  })

  it('wraps a bare primitive return', () => {
    expect(normaliseToolOutput('hello')).toEqual({ ok: true, data: 'hello' })
    expect(normaliseToolOutput(42)).toEqual({ ok: true, data: 42 })
  })

  it('wraps an object that lacks an ok field', () => {
    const out = normaliseToolOutput({ rows: [], total: 0 })
    expect(out).toEqual({ ok: true, data: { rows: [], total: 0 } })
  })

  it('wraps null / undefined returns as success with that data', () => {
    expect(normaliseToolOutput(null)).toEqual({ ok: true, data: null })
    expect(normaliseToolOutput(undefined)).toEqual({ ok: true, data: undefined })
  })

  /**
   * The regression this pins. `AiToolOutputSchema` is an OPEN TypeBox object,
   * so a raw payload that happens to carry its own `ok` — the shape most
   * Studio tools return — validated as a well-formed envelope and passed
   * through with `data` left undefined.
   *
   * Invisible on the chat path, which forwards the whole object to the
   * provider. Fatal on the MCP path, which reads `output.data` and falls back
   * to `{ ok: true }`: `studio_read_file`, `studio_list_tokens`,
   * `studio_list_components` and `studio_read_package_doc` all answered an
   * external MCP client with a bare `{"ok":true}` carrying no payload at all,
   * and no error to explain the emptiness.
   */
  it('wraps a raw payload that happens to carry its own ok field, so MCP does not lose it', () => {
    const raw = { ok: true, dir: '/w/proj', path: '.claude/design-system.md', content: '# tokens' }
    const out = normaliseToolOutput(raw)

    expect(out.data).toEqual(raw)
    // What the MCP layer actually sends: previously `{ ok: true }` and nothing else.
    expect(out.data).not.toBeUndefined()
  })

  it('treats a pure envelope as an envelope — no double wrapping', () => {
    expect(normaliseToolOutput({ ok: true, data: { a: 1 } })).toEqual({ ok: true, data: { a: 1 } })
    expect(normaliseToolOutput({ ok: true })).toEqual({ ok: true })
    expect(normaliseToolOutput({ ok: false, error: 'nope' })).toEqual({ ok: false, error: 'nope' })
  })

  it('NEVER re-wraps a failure carrying an extra field — that would turn an error into a success', () => {
    // The hazard the `ok === false` clause exists for: wrapping this would
    // produce `{ ok: true, data: { ok: false, … } }`, and every caller that
    // checks `output.ok` would read a failed tool call as having succeeded —
    // strictly worse than the dropped payload being fixed here.
    const out = normaliseToolOutput({ ok: false, error: 'refused', hint: 'try again' })

    expect(out.ok).toBe(false)
    expect(out.error).toBe('refused')
  })
})

