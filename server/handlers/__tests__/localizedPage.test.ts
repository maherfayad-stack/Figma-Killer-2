/**
 * localizedPage.ts / `loadStudioPageInLocale` — WS-10 §4.2/§4.4 (Phase 4).
 *
 * The proof the coordinator asked for by name: a text edit in the Arabic
 * frame must write to `translations.js`'s `ar` branch, not `en`'s. This is
 * `textOrigin`'s job, and it already falls out of the existing §7.4
 * mechanism (Tier B.4's dynamic-dictionary-key pick, `preferredKey`) —
 * these tests are the UNIT-LEVEL proof: two locale parses of the SAME page
 * produce the SAME node id (trap #2 — no node mints a locale-suffixed id)
 * but DIFFERENT `textOrigin` locations, each pointing at that locale's own
 * string literal. If a writeback consumer uses the locale-variant node's
 * OWN `textOrigin` (as `inlineEditSlice.ts`'s locale-variant path does —
 * see its module doc), the write lands in the correct dictionary branch by
 * construction, not by coincidence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadStudioPageInLocale, loadStudioPages } from '../studioPageLoad'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localized-page-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/**
 * Same shape `staticEval.test.ts`'s `writeLanguageContext` uses (a proven
 * §7.4 fixture) — a single `<Ctx.Provider>` Tier B traces through
 * `useLanguage()`, `t: translations[lang]` a non-statically-known dynamic
 * key. Mirrors the REAL eSIM corpus in the one respect that mattered for
 * `detectDictionaryIndex` (`localeProbe.ts`): the dictionary and its access
 * site are TWO DIFFERENT files.
 */
function writeLanguageFixture(): void {
  write(
    'i18n/translations.js',
    "export const translations = { en: { greeting: 'Hi Muhammad' }, ar: { greeting: 'مرحبا' } }\n",
  )
  write(
    'i18n/LanguageContext.jsx',
    [
      "import { createContext, useContext, useMemo, useState } from 'react'",
      "import { translations } from './translations'",
      'const LanguageContext = createContext(null)',
      'export function LanguageProvider({ children }) {',
      "  const [lang, setLang] = useState('en')",
      '  const value = useMemo(() => ({ lang, t: translations[lang] }), [lang])',
      '  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>',
      '}',
      'export function useLanguage() {',
      '  const ctx = useContext(LanguageContext)',
      "  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')",
      '  return ctx',
      '}',
      '',
    ].join('\n'),
  )
}

describe('loadStudioPageInLocale', () => {
  it('a text node keeps the SAME id across two locale parses, but carries a DIFFERENT textOrigin pointing at that locale\'s own literal', async () => {
    writeLanguageFixture()
    write(
      'pages/Home.jsx',
      [
        "import { useLanguage } from '../i18n/LanguageContext'",
        'export default function Home() {',
        '  const { t } = useLanguage()',
        '  return <p>{t.greeting}</p>',
        '}',
        '',
      ].join('\n'),
    )

    // The default (board-global) load, no locale override — first key in
    // source order, matching `evaluateElementAccess`'s own fallback.
    const { pages } = await loadStudioPages(tmpDir)
    const defaultPage = pages[0]!
    const pageId = defaultPage.id

    const enPage = await loadStudioPageInLocale(tmpDir, pageId, 'en')
    const arPage = await loadStudioPageInLocale(tmpDir, pageId, 'ar')
    expect(enPage).not.toBeNull()
    expect(arPage).not.toBeNull()

    const enTextNode = Object.values(enPage!.nodes).find((n) => n.moduleId === 'base.text')!
    const arTextNode = Object.values(arPage!.nodes).find((n) => n.moduleId === 'base.text')!

    // Trap #2 — the SAME node id in both locale parses. Node ids are
    // `${relFile}:${line}:${col}` (the JSX element's own AST position),
    // never a function of the resolved VALUE, so this holds independent of
    // which branch the dictionary picked.
    expect(enTextNode.id).toBe(arTextNode.id)

    // The actual English/Arabic copy resolved for the SAME element.
    expect(enTextNode.props.text).toBe('Hi Muhammad')
    expect(arTextNode.props.text).toBe('مرحبا')

    // The proof: each variant's `textOrigin` points at ITS OWN locale's
    // string literal — same file (`i18n/translations.js`), same LINE (both
    // literals are declared on the one-line object literal), but a
    // DIFFERENT column, because "Hi Muhammad" and "مرحبا" are two distinct
    // source locations. A write using `arTextNode.textOrigin` therefore
    // targets the `ar` branch specifically, never the `en` one.
    expect(enTextNode.textOrigin).toBeDefined()
    expect(arTextNode.textOrigin).toBeDefined()
    expect(enTextNode.textOrigin!.rel.replace(/\\/g, '/')).toBe('i18n/translations.js')
    expect(arTextNode.textOrigin!.rel.replace(/\\/g, '/')).toBe('i18n/translations.js')
    expect(enTextNode.textOrigin!.line).toBe(arTextNode.textOrigin!.line)
    expect(enTextNode.textOrigin!.col).not.toBe(arTextNode.textOrigin!.col)
  })

  it('returns null for a pageId that does not exist on this project', async () => {
    writeLanguageFixture()
    write('pages/Home.jsx', 'export default function Home() { return <p>Hi</p> }\n')
    const result = await loadStudioPageInLocale(tmpDir, 'does-not-exist', 'ar')
    expect(result).toBeNull()
  })

  it('a locale-variant page keeps the same classIds as the default-locale page for an unrelated styled node', async () => {
    writeLanguageFixture()
    write('pages/Home.css', '.title { color: red; }\n')
    write(
      'pages/Home.jsx',
      [
        "import { useLanguage } from '../i18n/LanguageContext'",
        "import './Home.css'",
        'export default function Home() {',
        '  const { t } = useLanguage()',
        '  return <h1 className="title">{t.greeting}</h1>',
        '}',
        '',
      ].join('\n'),
    )
    const { pages } = await loadStudioPages(tmpDir)
    const pageId = pages[0]!.id

    const arPage = await loadStudioPageInLocale(tmpDir, pageId, 'ar')
    const defaultNode = Object.values(pages[0]!.nodes).find((n) => n.props.customTag === 'h1' || n.props.tag === 'h1')!
    const arNode = Object.values(arPage!.nodes).find((n) => n.props.customTag === 'h1' || n.props.tag === 'h1')!

    // `styleRuleId` is content-hash deterministic (kind|name), not
    // sequentially assigned — a locale-variant page's SCOPED style scan
    // produces the SAME class id the site-wide default load already put in
    // `site.styleRules`, so the client never has to merge a second registry.
    expect(arNode.classIds).toEqual(defaultNode.classIds)
    expect(arNode.classIds.length).toBeGreaterThan(0)
  })
})
