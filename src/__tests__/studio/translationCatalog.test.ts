/**
 * translationCatalog / translationWrite — reading and editing a project's own
 * locale dictionary, the data layer behind the Content panel.
 *
 * `localeProbe` already reported which locales exist; these two modules answer
 * "what does each one say" and "change what it says". The cases below pin the
 * three properties that make that safe to hand a user: nested keys survive the
 * round trip, a missing Arabic entry is CREATED rather than refused (that is
 * the normal state the panel exists to fix), and a value that is code rather
 * than a string is refused rather than silently overwritten.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectsRootDir } from '../../../server/handlers/studioProjects'
import { readTranslationCatalog } from '../../../server/handlers/studio/translationCatalog'
import { writeTranslationEntry } from '../../../server/handlers/studio/translationWrite'

let dir: string

function write(rel: string, contents: string): void {
  const full = join(dir, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

/** A project shaped like `esim-journey`: a `translations[lang]` dictionary read through an index expression. */
function seedDictionaryProject(): void {
  write('package.json', JSON.stringify({ name: 'fixture' }))
  write(
    'src/i18n/translations.js',
    [
      'export const translations = {',
      '  en: {',
      "    greeting: 'Hello',",
      '    nav: {',
      "      home: 'Home',",
      '    },',
      '  },',
      '  ar: {',
      "    greeting: 'مرحبا',",
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  write(
    'src/App.jsx',
    ["import { translations } from './i18n/translations'", 'export default function App() {', '  const t = translations[lang]', '  return <p>{t.greeting}</p>', '}', ''].join('\n'),
  )
}

beforeEach(() => {
  const root = projectsRootDir()
  mkdirSync(root, { recursive: true })
  dir = mkdtempSync(join(root, '__translations_test_'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('translation catalog', () => {
  it('flattens nested keys and pairs both locales on one row', () => {
    seedDictionaryProject()
    const catalog = readTranslationCatalog(dir)
    expect(catalog).not.toBeNull()
    expect(catalog!.perLocaleFiles).toBe(false)

    const byKey = new Map(catalog!.entries.map((e) => [e.key, e.values]))
    expect(byKey.get('greeting')).toEqual({ en: 'Hello', ar: 'مرحبا' })
    // Nested keys are addressable, not dropped and not rendered as objects.
    expect(byKey.get('nav.home')).toEqual({ en: 'Home' })
  })

  it('is null — not an empty table — for a project that declares no locales', () => {
    write('package.json', JSON.stringify({ name: 'fixture' }))
    write('src/App.jsx', 'export default function App() { return <p>Hi</p> }')
    expect(readTranslationCatalog(dir)).toBeNull()
  })

  it('creates a missing Arabic entry, including its intermediate objects', () => {
    seedDictionaryProject()
    // `nav.home` has no Arabic at all — the normal state the panel exists for.
    expect(writeTranslationEntry(dir, { locale: 'ar', key: 'nav.home', value: 'الرئيسية' })).toEqual({ ok: true })

    const byKey = new Map(readTranslationCatalog(dir)!.entries.map((e) => [e.key, e.values]))
    expect(byKey.get('nav.home')).toEqual({ en: 'Home', ar: 'الرئيسية' })
    // The English side is untouched.
    expect(byKey.get('greeting')?.en).toBe('Hello')
  })

  it('overwrites an existing value in place', () => {
    seedDictionaryProject()
    expect(writeTranslationEntry(dir, { locale: 'ar', key: 'greeting', value: 'أهلاً' })).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'src/i18n/translations.js'), 'utf8')).toContain("greeting: 'أهلاً'")
  })

  it('refuses to overwrite a value that is code rather than a string', () => {
    write('package.json', JSON.stringify({ name: 'fixture' }))
    write(
      'src/i18n/translations.js',
      ['export const translations = {', '  en: { greeting: buildGreeting() },', "  ar: { greeting: 'مرحبا' },", '}', ''].join('\n'),
    )
    write('src/App.jsx', "const t = translations[lang]\nexport default function App() { return <p>{t.greeting}</p> }")

    const result = writeTranslationEntry(dir, { locale: 'en', key: 'greeting', value: 'Hi' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('expression')
    // Refused BEFORE writing — the call is still there.
    expect(readFileSync(join(dir, 'src/i18n/translations.js'), 'utf8')).toContain('buildGreeting()')
  })

  it('refuses a locale the project does not declare', () => {
    seedDictionaryProject()
    const result = writeTranslationEntry(dir, { locale: 'fr', key: 'greeting', value: 'Salut' })
    expect(result.ok).toBe(false)
  })
})
