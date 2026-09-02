/**
 * AI translation — the two pieces worth pinning without a live model.
 *
 * `selectPendingEntries` decides what a bulk "Translate missing" run touches.
 * The dangerous mistake is including entries that already have Arabic: a
 * reviewed translation silently replaced by a machine one is invisible until
 * someone reads the diff, so "no explicit keys means fill the gaps, never
 * overwrite" is pinned here directly.
 *
 * `runOneShotCompletion` is the tool-free driver entry. The bridge assertion
 * is the point: with `tools: []` no driver may legitimately reach the browser,
 * and the helper encodes that by passing a bridge that throws rather than a
 * stub that would hang.
 */
import { describe, expect, it } from 'bun:test'
import { selectPendingEntries } from '../../../server/ai/handlers/translateContent'
import { runOneShotCompletion } from '../../../server/ai/oneShot'
import type { AiProvider } from '../../../server/ai/drivers/types'

const ENTRIES = [
  { key: 'greeting', values: { en: 'Hello', ar: 'مرحبا' } },
  { key: 'nav.home', values: { en: 'Home' } },
  { key: 'nav.away', values: { en: 'Away', ar: '   ' } },
  { key: 'orphan', values: { ar: 'يتيم' } },
]

describe('selectPendingEntries', () => {
  it('fills gaps without touching an existing translation', () => {
    const pending = selectPendingEntries(ENTRIES, { sourceLocale: 'en', targetLocale: 'ar' })
    // `greeting` already has Arabic and must be left alone; `nav.away` holds
    // only whitespace, which is a gap, not a translation.
    expect(pending.map((e) => e.key)).toEqual(['nav.home', 'nav.away'])
  })

  it('skips an entry with no source text to translate from', () => {
    const pending = selectPendingEntries(ENTRIES, { sourceLocale: 'en', targetLocale: 'ar' })
    expect(pending.some((e) => e.key === 'orphan')).toBe(false)
  })

  it('retranslates an explicitly named key even when it already has a value', () => {
    const pending = selectPendingEntries(ENTRIES, { sourceLocale: 'en', targetLocale: 'ar', keys: ['greeting'] })
    expect(pending.map((e) => e.key)).toEqual(['greeting'])
  })
})

/** A driver that yields a fixed script of events and records the request it was handed. */
function fakeDriver(events: { type: 'text'; text: string }[]): { driver: AiProvider; seen: { tools: unknown[] }[] } {
  const seen: { tools: unknown[] }[] = []
  const driver = {
    id: 'anthropic',
    label: 'fake',
    supportedAuthModes: ['apiKey'],
    capabilities: () => ({ toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true }),
    async *stream(req: { tools: unknown[]; bridge: { callBrowser: (n: string, i: unknown) => Promise<unknown> } }) {
      seen.push({ tools: req.tools })
      yield* events
    },
  } as unknown as AiProvider
  return { driver, seen }
}

const CREDENTIALS = { providerId: 'anthropic', apiKey: 'k' } as never

describe('runOneShotCompletion', () => {
  it('concatenates the streamed text deltas', async () => {
    const { driver } = fakeDriver([
      { type: 'text', text: '{"a":' },
      { type: 'text', text: '"b"}' },
    ])
    const text = await runOneShotCompletion({
      driver,
      credentials: CREDENTIALS,
      modelId: 'm',
      systemPrompt: 'sys',
      userMessage: 'user',
      signal: new AbortController().signal,
      toolContextBase: { db: null, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null } as never,
    })
    expect(text).toBe('{"a":"b"}')
  })

  it('offers the driver no tools at all', async () => {
    const { driver, seen } = fakeDriver([{ type: 'text', text: 'hi' }])
    await runOneShotCompletion({
      driver,
      credentials: CREDENTIALS,
      modelId: 'm',
      systemPrompt: 'sys',
      userMessage: 'user',
      signal: new AbortController().signal,
      toolContextBase: { db: null, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null } as never,
    })
    expect(seen[0]!.tools).toEqual([])
  })
})
