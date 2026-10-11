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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyTranslations, selectPendingEntries } from '../../../server/ai/handlers/translateContent'
import { readTranslationCatalog } from '../../../server/handlers/studio/translationCatalog'
import { projectsRootDir } from '../../../server/handlers/studioProjects'
import { AiOneShotError, runOneShotCompletion } from '../../../server/ai/oneShot'
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
function fakeDriver(
  events: ({ type: 'text'; text: string } | { type: 'error'; message: string; authFailure?: boolean })[],
): { driver: AiProvider; seen: { tools: unknown[] }[] } {
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
      instructions: 'sys',
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
      instructions: 'sys',
      userMessage: 'user',
      signal: new AbortController().signal,
      toolContextBase: { db: null, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null } as never,
    })
    expect(seen[0]!.tools).toEqual([])
  })

  /**
   * The Claude CLI's own auth-failure line (`is_error: true`,
   * `api_error_status: 401`) becomes an `error` stream event — one that used
   * to be silently DROPPED here (only `text` events were accumulated), so a
   * revoked setup-token produced an empty string, and `translateContent.ts`
   * reported "the model replied with no JSON object" for a problem that was
   * never about JSON at all.
   */
  it('throws rather than silently returning empty text on an error event', async () => {
    const { driver } = fakeDriver([{ type: 'error', message: 'Claude CLI turn failed.' }])
    await expect(
      runOneShotCompletion({
        driver,
        credentials: CREDENTIALS,
        modelId: 'm',
        instructions: 'sys',
        userMessage: 'user',
        signal: new AbortController().signal,
        toolContextBase: { db: null, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null } as never,
      }),
    ).rejects.toThrow('Claude CLI turn failed.')
  })

  it('marks the thrown error authFailure when the driver flags a credential rejection', async () => {
    const { driver } = fakeDriver([
      {
        type: 'error',
        message: 'Claude CLI error: Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
        authFailure: true,
      },
    ])
    try {
      await runOneShotCompletion({
        driver,
        credentials: CREDENTIALS,
        modelId: 'm',
        instructions: 'sys',
        userMessage: 'user',
        signal: new AbortController().signal,
        toolContextBase: { db: null, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null } as never,
      })
      throw new Error('expected a rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(AiOneShotError)
      expect((err as AiOneShotError).authFailure).toBe(true)
    }
  })

  it('does not flag authFailure for an ordinary (non-credential) error event', async () => {
    const { driver } = fakeDriver([{ type: 'error', message: 'The provider is overloaded.' }])
    try {
      await runOneShotCompletion({
        driver,
        credentials: CREDENTIALS,
        modelId: 'm',
        instructions: 'sys',
        userMessage: 'user',
        signal: new AbortController().signal,
        toolContextBase: { db: null, userId: 'u', capabilities: [], conversationId: 'c', snapshot: null } as never,
      })
      throw new Error('expected a rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(AiOneShotError)
      expect((err as AiOneShotError).authFailure).toBe(false)
    }
  })
})

/**
 * The write half of a translate run — the 2026-09-30 owner report. After a
 * "Translate -> ar" run, the SAME new Arabic appeared in `en` (`sMS.label`
 * 'Label' -> 'التسمية'), and an `en` hand fix made minutes earlier was gone.
 * A translation writes the TARGET locale only, one entry at a time, and never
 * over a value that changed while the model was answering.
 */
describe('applyTranslations', () => {
  let dir: string
  const FILE = 'src/i18n/translations.js'
  const DICTIONARY = [
    'export const translations = {',
    '  en: {',
    '    sMS: {',
    "      label: 'Label',",
    "      home: 'Home',",
    '    },',
    "    time: '9:41 AM',",
    '  },',
    '  ar: {',
    '    sMS: {',
    "      home: 'البيت',",
    '    },',
    "    time: '9:41 AM',",
    '  },',
    '}',
    '',
  ].join('\n')

  function write(rel: string, contents: string): void {
    const full = join(dir, ...rel.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents, 'utf8')
  }

  function enSection(text: string): string {
    return text.slice(text.indexOf('  en: {'), text.indexOf('  ar: {'))
  }

  beforeEach(() => {
    const root = projectsRootDir()
    mkdirSync(root, { recursive: true })
    dir = mkdtempSync(join(root, '__translate_apply_test_'))
    write('package.json', JSON.stringify({ name: 'fixture' }))
    write(FILE, DICTIONARY)
    write(
      'src/App.jsx',
      ["import { translations } from './i18n/translations'", 'export default function App() {', '  const t = translations[lang]', '  return <p>{t.sMS.label}</p>', '}', ''].join('\n'),
    )
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes only the target locale: the source locale is byte-identical afterwards', () => {
    const catalog = readTranslationCatalog(dir)!
    const batch = selectPendingEntries(catalog.entries, { sourceLocale: 'en', targetLocale: 'ar' })
    // `time` is pending because its `ar` is just the English handed back.
    expect(batch.map((entry) => entry.key).sort()).toEqual(['sMS.label', 'time'])

    const result = applyTranslations(dir, 'ar', batch, { 'sMS.label': 'التسمية', time: '9:41 صباحًا' })

    expect(result).toEqual({ translated: 2, skipped: [], failures: [] })
    const after = readFileSync(join(dir, FILE), 'utf8')
    expect(enSection(after)).toBe(enSection(DICTIONARY))
    const byKey = new Map(readTranslationCatalog(dir)!.entries.map((entry) => [entry.key, entry.values]))
    expect(byKey.get('sMS.label')).toEqual({ en: 'Label', ar: 'التسمية' })
    expect(byKey.get('time')).toEqual({ en: '9:41 AM', ar: '9:41 صباحًا' })
  })

  it('never writes over a target entry that changed on disk while the model was answering', () => {
    const catalog = readTranslationCatalog(dir)!
    const batch = selectPendingEntries(catalog.entries, { sourceLocale: 'en', targetLocale: 'ar' })

    // The model call takes a while; meanwhile someone fixes `ar.time` by hand.
    const handFixed = readFileSync(join(dir, FILE), 'utf8').replace("    time: '9:41 AM',\n  },\n}", "    time: '9:41 ص',\n  },\n}")
    expect(handFixed).not.toBe(DICTIONARY)
    write(FILE, handFixed)

    const result = applyTranslations(dir, 'ar', batch, { 'sMS.label': 'التسمية', time: '9:41 صباحًا' })

    expect(result.translated).toBe(1)
    expect(result.failures.map((failure) => failure.key)).toEqual(['time'])
    const byKey = new Map(readTranslationCatalog(dir)!.entries.map((entry) => [entry.key, entry.values]))
    expect(byKey.get('time')).toEqual({ en: '9:41 AM', ar: '9:41 ص' })
    expect(byKey.get('sMS.label')).toEqual({ en: 'Label', ar: 'التسمية' })
    expect(enSection(readFileSync(join(dir, FILE), 'utf8'))).toBe(enSection(DICTIONARY))
  })

  it('reports a key the model left out as skipped, and writes nothing for it', () => {
    const catalog = readTranslationCatalog(dir)!
    const batch = selectPendingEntries(catalog.entries, { sourceLocale: 'en', targetLocale: 'ar' })

    const result = applyTranslations(dir, 'ar', batch, { 'sMS.label': 'التسمية' })

    expect(result.skipped).toEqual(['time'])
    expect(readTranslationCatalog(dir)!.entries.find((entry) => entry.key === 'time')!.values.ar).toBe('9:41 AM')
  })
})
