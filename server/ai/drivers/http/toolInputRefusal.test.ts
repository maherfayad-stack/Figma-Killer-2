/**
 * AI-27 — a schema failure names the field, the expected shape, and a call
 * that would have worked.
 *
 * Exercised through `executeAiTool`, the one choke point both the HTTP tool
 * loop and the MCP server reach, so the assertions are about what a model
 * actually receives: the `error` string (the only thing every driver
 * forwards) plus the structured fields the chat path keeps.
 */
import { describe, expect, it } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { isToolRefusal } from '@core/ai'
import { executeAiTool } from './execTool'
import { studioAgentTools } from '../../tools/studio'
import type { AiTool, AiToolOutput } from '../../runtime/types'

function toolWith(inputSchema: AiTool['inputSchema'], onRun: () => void = () => {}): AiTool {
  return {
    name: 'studio_probe',
    description: 'test',
    scope: 'shared',
    execution: 'server',
    sideEffects: 'none',
    inputSchema,
    handler: async () => {
      onRun()
      return { ran: true }
    },
  }
}

async function call(tool: AiTool, input: unknown): Promise<AiToolOutput & Record<string, unknown>> {
  return (await executeAiTool(tool, input, { callBrowser: async () => ({ ok: true }) }, new AbortController().signal, {
    db: {} as never,
    userId: 'u1',
    conversationId: 'c1',
    snapshot: {},
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
  })) as AiToolOutput & Record<string, unknown>
}

const PageSchema = Type.Object(
  {
    pageId: Type.String({ minLength: 1 }),
    pages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
    colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
    dpr: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3 })),
  },
  { additionalProperties: false },
)

describe('schema failures explain themselves (AI-27)', () => {
  it('a missing required field: its path, what it must be, and a minimal valid call', async () => {
    let ran = false
    const out = await call(toolWith(PageSchema, () => { ran = true }), {})

    expect(ran).toBe(false)
    expect(out.ok).toBe(false)
    expect(isToolRefusal(out)).toBe(true)
    expect(out.code).toBe('input-schema-mismatch')
    expect(out.retryable).toBe(false)
    expect(out.error).toContain('at /pageId expected string (at least 1 character), got nothing')
    // The example carries the required field only, and it validates.
    expect(out.error).toContain('A minimal valid call (required fields only) is {"pageId":"<pageId>"}')
    expect(out.example).toEqual({ pageId: '<pageId>' })
  })

  it('a wrong type inside an array names the element path and what arrived', async () => {
    // An object, not a number: TypeBox's parse pipeline CONVERTS a number to a
    // string before it validates, so only an inconvertible value fails.
    const out = await call(toolWith(PageSchema), { pageId: 'Home', pages: [{ name: 'Checkout' }] })
    expect(out.error).toContain('at /pages/0 expected string (at least 1 character), got an object')
  })

  it('a union of literals lists the accepted values', async () => {
    const out = await call(toolWith(PageSchema), { pageId: 'Home', colorScheme: 'blue' })
    expect(out.error).toContain('at /colorScheme expected one of "light" | "dark", got string "blue"')
  })

  it('a numeric bound is stated as a bound', async () => {
    const out = await call(toolWith(PageSchema), { pageId: 'Home', dpr: 9 })
    expect(out.error).toContain('at /dpr expected number (>= 0.5, <= 3), got number 9')
  })

  it('offers no example when none it could build would validate', async () => {
    const Patterned = Type.Object({ sha: Type.String({ pattern: '^[0-9a-f]{40}$' }) })
    const out = await call(toolWith(Patterned), { sha: 'nope' })
    expect(out.error).toContain('at /sha expected string (matching /^[0-9a-f]{40}$/)')
    expect(out.error).not.toContain('minimal valid call')
    expect(out.example).toBeUndefined()
  })

  it('a non-object argument is reported at the root', async () => {
    const out = await call(toolWith(PageSchema), 'Home')
    expect(out.error).toContain('at (root) expected object with required pageId')
  })

  it('names at most three fields, however many are wrong', async () => {
    const Many = Type.Object({ a: Type.String(), b: Type.String(), c: Type.String(), d: Type.String(), e: Type.String() })
    const out = await call(toolWith(Many), {})
    expect((out.issues as unknown[]).length).toBe(3)
  })

  it('a real tool: studio_screenshot given a word where its scale factor goes', async () => {
    const screenshot = studioAgentTools.find((tool) => tool.name === 'studio_screenshot')!
    const out = await call(screenshot, { dpr: 'retina' })
    expect(out.code).toBe('input-schema-mismatch')
    expect(out.error).toContain('at /dpr expected number (>= 0.5, <= 3), got string "retina"')
    // Every field of the screenshot schema is optional: the minimal call is `{}`.
    expect(out.error).toContain('is {}')
  })
})
