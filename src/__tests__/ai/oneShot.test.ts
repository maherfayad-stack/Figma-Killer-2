/**
 * oneShot — a single tool-free completion.
 *
 * The first test here is a regression, and the bug it pins is worth naming:
 * the instructions used to travel in `AiStreamRequest.systemPrompt`, and
 * `claudeCli` — the CLI-shaped driver — does not forward that field. The
 * model received a bare JSON blob with no request attached and replied
 * asking what it was supposed to do with it. Composing the instruction into
 * the single user message is what makes a one-shot reach EVERY driver rather
 * than most of them, so it is asserted here rather than left to a comment.
 */
import { describe, expect, it } from 'bun:test'
import { runOneShotCompletion } from '../../../server/ai/oneShot'
import type { AiProvider, AiStreamRequest } from '../../../server/ai/drivers/types'

/** A driver that records the request it was handed and replies with fixed events. `capabilities` is the one other member `runOneShotCompletion` touches. */
function fakeDriver(
  events: () => Iterable<unknown>,
): { driver: AiProvider; seen: AiStreamRequest[] } {
  const seen: AiStreamRequest[] = []
  const driver = {
    capabilities: () => ({ visionInput: false, promptCache: false }),
    async *stream(req: AiStreamRequest) {
      seen.push(req)
      yield* events() as Iterable<never>
    },
  } as unknown as AiProvider
  return { driver, seen }
}

function recordingDriver(reply: string): { driver: AiProvider; seen: AiStreamRequest[] } {
  return fakeDriver(() => [{ type: 'text', text: reply }])
}

function run(driver: AiProvider) {
  return runOneShotCompletion({
    driver,
    credentials: { authMode: 'apiKey', apiKey: 'test' } as never,
    modelId: 'test-model',
    instructions: 'Translate the JSON below.',
    userMessage: '{"a": "Hello"}',
    signal: new AbortController().signal,
    toolContextBase: { db: null, userId: 'u1', capabilities: [], conversationId: 'c1', snapshot: null } as never,
  })
}

describe('runOneShotCompletion', () => {
  it('sends the instructions inside the user message, not as a system prompt', async () => {
    const { driver, seen } = recordingDriver('ok')
    await run(driver)

    const req = seen[0]!
    // A driver that ignores `systemPrompt` (claudeCli) must still receive the
    // instruction — so it cannot live there.
    expect(req.systemPrompt).toEqual([])
    expect(req.messages).toHaveLength(1)
    const block = req.messages[0]!.content[0]!
    expect(block.kind).toBe('text')
    expect(block.kind === 'text' && block.text).toContain('Translate the JSON below.')
    expect(block.kind === 'text' && block.text).toContain('{"a": "Hello"}')
  })

  it('offers no tools, so no driver can reach the browser bridge', async () => {
    const { driver, seen } = recordingDriver('ok')
    await run(driver)
    expect(seen[0]!.tools).toEqual([])
  })

  it('concatenates text events and trims the result', async () => {
    const { driver } = fakeDriver(() => [
      { type: 'text', text: '  {"a":' },
      // A tool-call event against an empty tool list is skipped, not thrown.
      { type: 'tool_call', id: 'x', name: 'nope', input: {} },
      { type: 'text', text: ' "مرحبا"}  ' },
    ])

    expect(await run(driver)).toBe('{"a": "مرحبا"}')
  })
})
