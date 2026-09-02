/**
 * i18nSetup — turning a project with no localisation at all into one with
 * English and Arabic.
 *
 * The end-to-end case is the one that matters, and it has a subtle
 * requirement: the generated module has to be a shape `localeProbe.ts` then
 * DETECTS, or the panel would scaffold a dictionary it could never read back.
 * That round trip — write, re-probe, read the catalogue — is what the first
 * test asserts, and it is why the scaffold's code shape is not a style choice
 * (see `i18nScaffold.ts`'s own doc).
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectsRootDir } from '../../../server/handlers/studioProjects'
import { detectLocales } from '../../../server/handlers/studio/localeProbe'
import { readTranslationCatalog } from '../../../server/handlers/studio/translationCatalog'
import { scaffoldProjectI18n } from '../../../server/handlers/studio/i18nScaffold'
import { mintKeys, setUpProjectI18n } from '../../../server/handlers/studio/i18nSetup'

let dir: string

function write(rel: string, contents: string): void {
  const full = join(dir, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

function read(rel: string): string {
  return readFileSync(join(dir, ...rel.split('/')), 'utf8')
}

beforeEach(() => {
  const root = projectsRootDir()
  mkdirSync(root, { recursive: true })
  dir = mkdtempSync(join(root, '__i18n_setup_test_'))
  write('package.json', JSON.stringify({ name: 'fixture' }))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('scaffoldProjectI18n', () => {
  it('writes a dictionary the locale probe then detects', () => {
    const result = scaffoldProjectI18n(dir)
    expect(result.ok).toBe(true)

    const capability = detectLocales(dir)
    expect(capability?.keys).toEqual(['en', 'ar'])
    expect(capability?.defaultKey).toBe('en')
    expect(capability?.source).toBe('i18n/translations.ts')
  })

  it('refuses a project that already has a dictionary rather than adding a second one', () => {
    write('i18n/translations.ts', "export const translations = { en: { a: 'A' }, ar: { a: 'ا' } }\nexport const pick = (l) => translations[l]\n")

    const result = scaffoldProjectI18n(dir)
    expect(result).toMatchObject({ ok: false })
  })
})

describe('mintKeys', () => {
  const base = { file: 'pages/Home.tsx', line: 1, col: 1, prop: 'label' as string | null }

  it('gives one key to the same text repeated in the same file', () => {
    const minted = mintKeys([
      { ...base, text: 'Add your text here.' },
      { ...base, line: 9, text: 'Add your text here.' },
    ])
    expect(minted.map((m) => m.key)).toEqual(['home.addYourTextHere', 'home.addYourTextHere'])
  })

  it('gives the same text in a different file its own key', () => {
    const minted = mintKeys([
      { ...base, text: 'Continue' },
      { ...base, file: 'pages/Page.tsx', text: 'Continue' },
    ])
    expect(minted.map((m) => m.key)).toEqual(['home.continue', 'page.continue'])
  })

  it('suffixes a name collision instead of merging two different strings', () => {
    // A key is minted from the first few words, so two different sentences
    // that OPEN the same way collide — and must stay two entries.
    const minted = mintKeys([
      { ...base, text: 'Sign in to your account now' },
      { ...base, text: 'Sign in to your account later' },
    ])
    expect(minted[0]!.key).toBe('home.signInToYourAccount')
    expect(minted[1]!.key).toBe('home.signInToYourAccount2')
  })
})

describe('setUpProjectI18n', () => {
  it('scaffolds, rewrites the JSX, and fills English — end to end', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return (',
        '    <main>',
        '      <Banner title="Profile verified" />',
        '      <p>Add your text here.</p>',
        '    </main>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const report = setUpProjectI18n(dir)
    expect(report.ok).toBe(true)
    if (!report.ok) return

    expect(report.extracted).toBe(2)
    expect(report.filesChanged).toBe(1)
    expect(report.failures).toEqual([])

    // The user's source now reads from the dictionary...
    const page = read('pages/Page.tsx')
    expect(page).toContain('title={t.page.profileVerified}')
    expect(page).toContain('const { t } = useLanguage()')

    // ...and the dictionary holds the English, with Arabic left for the
    // explicit translate action rather than filled with the English.
    const catalog = readTranslationCatalog(dir)
    const verified = catalog?.entries.find((entry) => entry.key === 'page.profileVerified')
    expect(verified?.values.en).toBe('Profile verified')
    expect(verified?.values.ar).toBeUndefined()
  })

  it('does not write a dictionary key for a string whose rewrite was refused', () => {
    write(
      'pages/Page.tsx',
      [
        "const HEADING = 'Welcome aboard traveller'",
        'export default function Page() {',
        '  return <Banner title="Profile verified" />',
        '}',
        '',
      ].join('\n'),
    )

    const report = setUpProjectI18n(dir)
    expect(report.ok).toBe(true)
    if (!report.ok) return

    // The module-scope literal cannot read a hook, so it stays put — and the
    // dictionary must not offer a key no screen reads.
    const keys = readTranslationCatalog(dir)?.entries.map((entry) => entry.key) ?? []
    expect(keys).toContain('page.profileVerified')
    expect(keys).not.toContain('page.welcomeAboardTraveller')
  })

  it('mints a valid identifier for text that starts with a digit', () => {
    const minted = mintKeys([
      { file: 'pages/Home.tsx', line: 1, col: 1, prop: 'value', text: '2 adults · Economy' },
    ])
    // `t.home.2AdultsEconomy` would be a syntax error; the digit is kept
    // because it is load-bearing in the string it names.
    expect(minted[0]!.key).toBe('home._2AdultsEconomy')
  })

  it('extracts again into a dictionary it already wrote, rather than refusing', () => {
    write(
      'pages/Page.tsx',
      [
        'export default function Page() {',
        '  return <Banner title="Profile verified" />',
        '}',
        '',
      ].join('\n'),
    )
    expect(setUpProjectI18n(dir).ok).toBe(true)

    // A screen written after the first run — its copy is still inline, and the
    // dictionary already exists.
    write(
      'pages/Later.tsx',
      [
        'export default function Later() {',
        '  return <Banner title="Booking confirmed" />',
        '}',
        '',
      ].join('\n'),
    )

    const second = setUpProjectI18n(dir)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.extracted).toBe(1)
    expect(read('pages/Later.tsx')).toContain('title={t.later.bookingConfirmed}')

    const keys = readTranslationCatalog(dir)?.entries.map((entry) => entry.key) ?? []
    expect(keys).toContain('page.profileVerified')
    expect(keys).toContain('later.bookingConfirmed')
  })

  it("refuses to extract into a dictionary Studio did not write", () => {
    write('i18n/translations.ts', "export const translations = { en: { a: 'A' }, ar: { a: 'ا' } }\nexport const pick = (l) => translations[l]\n")
    write('pages/Page.tsx', 'export default function Page() {\n  return <Banner title="Profile verified" />\n}\n')

    // Studio cannot know which hook a component should read strings from here,
    // and guessing would write an import to a symbol that may not exist.
    const result = setUpProjectI18n(dir)
    expect(result.ok).toBe(false)
  })
})
