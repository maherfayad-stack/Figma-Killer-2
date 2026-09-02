/**
 * extractStringsToDictionary — the codemod that moves hardcoded copy out of a
 * user's JSX and into a dictionary lookup.
 *
 * It writes the user's real source, so what it REFUSES matters as much as what
 * it rewrites: a literal it cannot address from a hook, a file that already
 * means something else by `t`, and a scan whose positions have gone stale all
 * have to fail loudly and individually rather than corrupt a file.
 */
import { describe, expect, it } from 'bun:test'
import { extractStringsToDictionary, type StringExtraction } from '@core/ast-codemods'

/**
 * The `(line, col)` of `needle` in `sourceText`, 1-based — the same addressing
 * `findHardcodedStrings` reports. Computed rather than hand-counted so a test
 * fixture can be edited without silently re-pointing at the wrong literal.
 */
function at(sourceText: string, needle: string, key: string): StringExtraction {
  const index = sourceText.indexOf(needle)
  if (index < 0) throw new Error(`fixture does not contain ${needle}`)
  const before = sourceText.slice(0, index)
  const line = before.split('\n').length
  const col = index - (before.lastIndexOf('\n') + 1) + 1
  return { line, col, text: needle, key }
}

function run(sourceText: string, extractions: StringExtraction[]) {
  return extractStringsToDictionary({
    sourceText,
    fileName: 'Page.tsx',
    extractions,
    importSpecifier: '../i18n/LanguageContext',
    hookName: 'useLanguage',
  })
}

const PAGE = [
  "import styles from './Page.module.css'",
  '',
  'export default function Page() {',
  '  return (',
  '    <main className={styles.page}>',
  '      <Banner title="Profile verified" />',
  '      <p>Add your text here.</p>',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

describe('extractStringsToDictionary', () => {
  it('rewrites an attribute literal, a JSX text child, and adds the import and hook once', () => {
    const result = run(PAGE, [
      at(PAGE, 'Profile verified', 'page.profileVerified'),
      at(PAGE, 'Add your text here.', 'page.addYourTextHere'),
    ])

    expect(result.refused).toEqual([])
    expect(result.applied).toEqual(['page.profileVerified', 'page.addYourTextHere'])
    expect(result.text).toContain('title={t.page.profileVerified}')
    expect(result.text).toContain('<p>{t.page.addYourTextHere}</p>')
    // One import and one hook call, no matter how many strings moved.
    expect(result.text.match(/useLanguage/g)).toHaveLength(2)
    expect(result.text).toContain("import { useLanguage } from '../i18n/LanguageContext'")
    expect(result.text).toContain('const { t } = useLanguage()')
  })

  it('matches the file’s own semicolon style rather than ts-morph’s default', () => {
    const result = run(PAGE, [at(PAGE, 'Profile verified', 'page.profileVerified')])
    expect(result.text).toContain("from '../i18n/LanguageContext'\n")
    expect(result.text).not.toContain("LanguageContext';")
  })

  it('rewrites a literal nested in a prop expression without braces', () => {
    const source = [
      'export default function Page() {',
      '  return <Navbar toolbar={{ variant: \'default\', title: \'Account\' }} />',
      '}',
      '',
    ].join('\n')

    const result = run(source, [at(source, 'Account', 'page.account')])
    expect(result.refused).toEqual([])
    // In expression position the accessor is bare — `title: {t.x}` is not valid.
    expect(result.text).toContain('title: t.page.account')
  })

  it('refuses a literal that is outside any component, and leaves the rest alone', () => {
    const source = [
      "const HEADING = 'Welcome aboard'",
      '',
      'export default function Page() {',
      '  return <Banner title="Profile verified" />',
      '}',
      '',
    ].join('\n')

    const result = run(source, [
      at(source, 'Welcome aboard', 'page.welcomeAboard'),
      at(source, 'Profile verified', 'page.profileVerified'),
    ])

    expect(result.applied).toEqual(['page.profileVerified'])
    expect(result.refused).toHaveLength(1)
    expect(result.refused[0]).toMatchObject({ key: 'page.welcomeAboard', reason: 'outside-component' })
    // The refused literal is untouched.
    expect(result.text).toContain("const HEADING = 'Welcome aboard'")
  })

  it('refuses the whole file when `t` already means something else there', () => {
    const source = [
      'export default function Page({ t }) {',
      '  return <Banner title="Profile verified" />',
      '}',
      '',
    ].join('\n')

    const result = run(source, [at(source, 'Profile verified', 'page.profileVerified')])
    expect(result.applied).toEqual([])
    expect(result.refused[0]).toMatchObject({ reason: 'name-taken' })
    expect(result.text).toBe(source)
  })

  it('refuses a position whose text has changed since it was scanned', () => {
    const result = run(PAGE, [{ ...at(PAGE, 'Profile verified', 'page.stale'), text: 'Something else entirely' }])
    expect(result.applied).toEqual([])
    expect(result.refused[0]).toMatchObject({ reason: 'text-changed' })
    expect(result.text).toBe(PAGE)
  })

  it('applies later positions first, so one edit never moves the next target', () => {
    const source = [
      'export default function Page() {',
      '  return (',
      '    <main>',
      '      <Banner title="A very long first heading indeed" />',
      '      <Banner title="Second" />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')

    const result = run(source, [
      at(source, 'A very long first heading indeed', 'page.first'),
      at(source, 'Second', 'page.second'),
    ])

    expect(result.refused).toEqual([])
    expect(result.text).toContain('title={t.page.first}')
    expect(result.text).toContain('title={t.page.second}')
  })

  it('reuses the hook binding a previous run added, instead of refusing the file', () => {
    // The regression: a second extraction lands in a file that already carries
    // `const { t } = useLanguage()` from the first, and a plain "is `t` bound?"
    // check reads Studio's own edit as a conflict. Measured on the real
    // project: 9 of 9 strings refused with "already binds t".
    const source = [
      "import { useLanguage } from '../i18n/LanguageContext'",
      '',
      'export default function Page() {',
      '  const { t } = useLanguage()',
      '  return (',
      '    <main>',
      '      <Banner title={t.page.old} />',
      '      <Banner title="Profile verified" />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')

    const result = run(source, [at(source, 'Profile verified', 'page.profileVerified')])
    expect(result.refused).toEqual([])
    expect(result.text).toContain('title={t.page.profileVerified}')
    // Still exactly one hook call and one import.
    expect(result.text.match(/useLanguage\(\)/g)).toHaveLength(1)
    expect(result.text.match(/from '\.\.\/i18n\/LanguageContext'/g)).toHaveLength(1)
  })

  it('still refuses a file where `t` means something else', () => {
    const source = [
      'export default function Page({ t }) {',
      '  return <Banner title="Profile verified" />',
      '}',
      '',
    ].join('\n')

    const result = run(source, [at(source, 'Profile verified', 'page.profileVerified')])
    expect(result.refused[0]).toMatchObject({ reason: 'name-taken' })
  })

  it('refuses a key that is not a valid property path, without losing the rest of the file', () => {
    // `2 adults · Economy` shortens to `2AdultsEconomy`, and
    // `t.home.2AdultsEconomy` is a syntax error — ts-morph rejects the whole
    // file's manipulation when one appears, which took down 8 innocent strings
    // alongside it.
    const source = [
      'export default function Page() {',
      '  return (',
      '    <main>',
      '      <Cell value="2 adults" />',
      '      <Banner title="Profile verified" />',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')

    const result = run(source, [
      at(source, '2 adults', 'home.2Adults'),
      at(source, 'Profile verified', 'page.profileVerified'),
    ])

    expect(result.refused).toHaveLength(1)
    expect(result.refused[0]).toMatchObject({ key: 'home.2Adults', reason: 'invalid-key' })
    // The valid one still lands.
    expect(result.applied).toEqual(['page.profileVerified'])
    expect(result.text).toContain('title={t.page.profileVerified}')
    expect(result.text).toContain('value="2 adults"')
  })
})
