/**
 * `toolRefusal` — the shape, the rendering, and the two invariants that make
 * the code worth having.
 */
import { describe, expect, it } from 'bun:test'
import {
  TOOL_REFUSAL_CODES,
  TOOL_REFUSAL_CODE_LIST,
  ToolRefusalSchema,
  isToolRefusal,
  toolRefusal,
} from './toolRefusal'
import { safeParseValue } from '@core/utils/typeboxHelpers'

describe('toolRefusal', () => {
  it('validates against its own schema', () => {
    const refusal = toolRefusal('no-such-page', 'No screen matched "Chekout".', { remedy: 'This project has: Checkout, Cart.' })
    expect(safeParseValue(ToolRefusalSchema, refusal).ok).toBe(true)
    expect(isToolRefusal(refusal)).toBe(true)
  })

  it('renders the code and retryable INTO `error`, because that is the only field the drivers forward', () => {
    // `mcp/server.ts`, `anthropic.ts`, `responses-shared.ts` and
    // `chatCompletions.ts` all reduce a failed tool result to `output.error`
    // and nothing else. A code that lives only in a sibling property is a
    // code the model never sees — which is the whole failure A14 fixes.
    const refusal = toolRefusal('trust-tier-required', 'This project is at "static" trust.', { remedy: 'Ask the user to promote it.' })
    expect(refusal.error).toContain('This project is at "static" trust.')
    expect(refusal.error).toContain('Ask the user to promote it.')
    expect(refusal.error).toContain('[code=trust-tier-required retryable=false]')
    // …and `message` stays the bare cause, without the rendered suffix.
    expect(refusal.message).toBe('This project is at "static" trust.')
  })

  it('derives retryable from the code table — it is never passed in', () => {
    expect(toolRefusal('no-such-page', 'x').retryable).toBe(false)
    expect(toolRefusal('no-board-connected', 'x').retryable).toBe(true)
    // Two call sites for the same code can never disagree.
    expect(toolRefusal('io-error', 'a').retryable).toBe(toolRefusal('io-error', 'b').retryable)
  })

  it('omits `remedy` entirely rather than emitting an empty one', () => {
    const refusal = toolRefusal('empty-body', 'A reply needs a non-empty body.')
    expect('remedy' in refusal).toBe(false)
    expect(refusal.error).toBe('A reply needs a non-empty body. [code=empty-body retryable=false]')
  })

  it('carries extra details, and no detail can shadow the refusal fields', () => {
    const refusal = toolRefusal('no-such-thread', 'No thread with seq 4.', {
      details: { availableSeqs: [1, 2, 3], ok: true, code: 'lies', retryable: true },
    })
    expect((refusal as Record<string, unknown>).availableSeqs).toEqual([1, 2, 3])
    expect(refusal.ok).toBe(false)
    expect(refusal.code).toBe('no-such-thread')
    expect(refusal.retryable).toBe(false)
  })
})

describe('the refusal code vocabulary', () => {
  it('every code documents what it means', () => {
    for (const code of TOOL_REFUSAL_CODE_LIST) {
      expect(TOOL_REFUSAL_CODES[code].meaning.length, `${code} has no meaning`).toBeGreaterThan(20)
    }
  })

  it('codes are kebab-case, so they read the same everywhere they appear', () => {
    for (const code of TOOL_REFUSAL_CODE_LIST) {
      expect(code, `${code} is not kebab-case`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    }
  })

  it('retryable is the exception, not the rule', () => {
    // If most codes became retryable the prompt rule would be noise. This is a
    // deliberate tripwire on the definition drifting from "the SAME args could
    // work later" to "this failure feels temporary".
    const retryable = TOOL_REFUSAL_CODE_LIST.filter((code) => TOOL_REFUSAL_CODES[code].retryable)
    expect(retryable.length).toBeLessThan(TOOL_REFUSAL_CODE_LIST.length / 4)
  })
})

describe('isToolRefusal', () => {
  it('rejects a success, a bare error object, and a non-object', () => {
    expect(isToolRefusal({ ok: true })).toBe(false)
    expect(isToolRefusal({ ok: false, error: 'nope' })).toBe(false)
    expect(isToolRefusal(null)).toBe(false)
    expect(isToolRefusal('no-such-page')).toBe(false)
  })
})
