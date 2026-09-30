/**
 * A lift onto the free canvas carries a context hook exactly as a
 * frame-to-frame move does (server-30's carry, `transplantJsxElement.ts`'s
 * `resolveCarriedBindings`): markup reading `t` from `const { t } =
 * useLanguage()` becomes a layer module that makes the same call itself, with
 * the hook's import specified from `.studio/canvas/`.
 *
 * The owner's case was test4's i18n screens; the second fixture shares nothing
 * with it (a theme context, a whole-value binding, an aliased key) so the
 * carry is not an i18n special case. The refusals it must KEEP — a prop, a
 * `.map` row, a non-context hook — are tested beside it: this change widened a
 * write, and each one it did not widen is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project, ts } from 'ts-morph'
import { liftJsxElementToCanvasModule, placeCanvasLayerRoot, transplantJsxElement } from '@core/ast-codemods'
import { createPageEvalBudget, createWorkspaceProject, parsePageFile } from '@core/page-parser'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-lift-hooks-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(rel: string, source: string): string {
  const filePath = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

const read = (file: string): string => fs.readFileSync(file, 'utf8')
const MODULE_REL = '.studio/canvas/cl0123456789.tsx'

function lift(file: string, source: string, tag: string, copy = false, occurrence = 1) {
  const at = locateTag(source, tag, occurrence)
  const moduleFile = path.join(tmpDir, ...MODULE_REL.split('/'))
  return {
    moduleFile,
    result: liftJsxElementToCanvasModule({
      file,
      line: at.line,
      col: at.col,
      moduleFile,
      ...(copy ? { copy: true } : {}),
      writeModule: (text) => {
        fs.mkdirSync(path.dirname(moduleFile), { recursive: true })
        fs.writeFileSync(moduleFile, text, { encoding: 'utf8', flag: 'wx' })
      },
    }),
  }
}

/**
 * Semantic diagnostics of the written files — "Cannot find name 't'" is the
 * regression this guards. No React types in a temp dir, so JSX is checked
 * permissively and `react` itself is unresolvable (the one missing module
 * allowed); every NAME and every relative import must still resolve.
 */
function nameErrors(files: string[]): string[] {
  const project = new Project({
    compilerOptions: { jsx: ts.JsxEmit.Preserve, noImplicitAny: false, strict: false, skipLibCheck: true, noLib: false },
    skipAddingFilesFromTsConfig: true,
  })
  for (const file of files) project.addSourceFileAtPath(file)
  return project
    .getPreEmitDiagnostics()
    .filter((d) => [2304, 2305, 2307, 2552, 2724].includes(d.getCode()))
    .map((d) => `${d.getSourceFile()?.getBaseName()}: ${ts.flattenDiagnosticMessageText(d.getMessageText() as string, '\n')}`)
    .filter((message) => !message.includes("module 'react'"))
}

// ── Fixture 1: the owner's shape (i18n context, destructured `t`) ──────────

const TRANSLATIONS = `export const translations = {
  en: { sms: { title: 'Enter the code', resend: 'Resend' } },
  ar: { sms: { title: 'أدخل الرمز', resend: 'إعادة الإرسال' } },
}
`

const LANGUAGE_CONTEXT = `import { createContext, useContext, useMemo, useState } from 'react'
import { translations } from './translations'

const LanguageContext = createContext({ lang: 'en', t: translations.en })

export function LanguageProvider({ children }) {
  const [lang] = useState('en')
  const value = useMemo(() => ({ lang, t: translations[lang] }), [lang])
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  return ctx
}
`

const SMS = `import { useLanguage } from '../i18n/LanguageContext'

export default function Sms() {
  const { t } = useLanguage()
  return (
    <main>
      <h1 className="title">{t.sms.title}</h1>
      <button>{t.sms.resend}</button>
    </main>
  )
}
`

const SMS_WITHOUT_TITLE = `import { useLanguage } from '../i18n/LanguageContext'

export default function Sms() {
  const { t } = useLanguage()
  return (
    <main>
      <button>{t.sms.resend}</button>
    </main>
  )
}
`

const TITLE_LAYER = `/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
import { useLanguage } from '../../i18n/LanguageContext'

export default function CanvasLayer() {
  const { t } = useLanguage()
  return (
    <h1 className="title">{t.sms.title}</h1>
  )
}
`

function writeI18nApp(): string {
  writeFixture('i18n/translations.ts', TRANSLATIONS)
  writeFixture('i18n/LanguageContext.tsx', LANGUAGE_CONTEXT)
  return writeFixture('pages/Sms.tsx', SMS)
}

describe('lift onto the free canvas — a context hook travels with the element', () => {
  it('re-establishes `const { t } = useLanguage()` in the layer, imports the hook from .studio/canvas, and cuts the element once', () => {
    const sms = writeI18nApp()
    const { moduleFile, result } = lift(sms, SMS, 'h1')

    expect(result).toEqual({ ok: true, carriedImports: ['useLanguage'], root: { line: 8, col: 6 } })
    expect(read(moduleFile)).toBe(TITLE_LAYER)
    expect(read(sms)).toBe(SMS_WITHOUT_TITLE)
    expect(locateTag(TITLE_LAYER, 'h1')).toEqual({ line: 8, col: 6 })
    expect(nameErrors([moduleFile, sms])).toEqual([])
  })

  it('a copy (Alt) writes the same layer and leaves the page byte-identical', () => {
    const sms = writeI18nApp()
    const { moduleFile, result } = lift(sms, SMS, 'h1', true)

    expect(result.ok).toBe(true)
    expect(read(moduleFile)).toBe(TITLE_LAYER)
    expect(read(sms)).toBe(SMS)
  })

  it('the layer parses to the translated text of the previewed locale', () => {
    const sms = writeI18nApp()
    const { moduleFile } = lift(sms, SMS, 'h1', true)
    const textOf = (preferredKey?: string) => {
      const parsed = parsePageFile(moduleFile, tmpDir, createWorkspaceProject(tmpDir), {
        pageBudget: createPageEvalBudget(),
        workspaceRoot: tmpDir,
        ...(preferredKey ? { preferredKey } : {}),
      })
      return Object.values(parsed.nodes).find((node) => node.name === 'h1')?.text
    }
    expect(textOf()).toBe('Enter the code')
    expect(textOf('ar')).toBe('أدخل الرمز')
  })

  it('placing the layer back reuses the page’s own call — lift + place is byte-exact', () => {
    const sms = writeI18nApp()
    const { moduleFile } = lift(sms, SMS, 'h1')
    const main = locateTag(SMS_WITHOUT_TITLE, 'main')
    const button = locateTag(SMS_WITHOUT_TITLE, 'button')

    const placed = placeCanvasLayerRoot({
      moduleFile,
      destinationFile: sms,
      destinationLine: main.line,
      destinationCol: main.col,
      anchorLine: button.line,
      anchorCol: button.col,
      position: 'before',
    })

    expect(placed.ok).toBe(true)
    expect(read(sms)).toBe(SMS)
  })
})

describe('the same carry in a JavaScript project', () => {
  // The codemods' ts-morph project had no `allowJs`: TypeScript neither bound
  // a `.jsx` page nor resolved an import to a `.jsx` context file, so
  // `useLanguage` resolved to nothing and the hook was refused in exactly the
  // repos (plain React + Vite, `.jsx`) most likely to be opened.
  function writeJsApp(): string {
    writeFixture('i18n/translations.js', TRANSLATIONS)
    writeFixture('i18n/LanguageContext.jsx', LANGUAGE_CONTEXT)
    return writeFixture('pages/Sms.jsx', SMS)
  }

  it('a lift from a .jsx page with a .jsx context carries the hook', () => {
    const sms = writeJsApp()
    const { moduleFile, result } = lift(sms, SMS, 'h1')

    expect(result.ok).toBe(true)
    expect(read(moduleFile)).toBe(TITLE_LAYER)
    expect(read(sms)).toBe(SMS_WITHOUT_TITLE)
  })

  it('a frame-to-frame move between .jsx pages carries it too (server-30’s path, same project)', () => {
    const sms = writeJsApp()
    const blank = `export default function Blank() {
  return (
    <section>
      <p>Blank</p>
    </section>
  )
}
`
    const other = writeFixture('pages/Blank.jsx', blank)
    const at = locateTag(SMS, 'h1')
    const section = locateTag(blank, 'section')
    const result = transplantJsxElement({
      file: sms,
      line: at.line,
      col: at.col,
      destinationFile: other,
      destinationLine: section.line,
      destinationCol: section.col,
      copy: true,
    })

    expect(result.ok).toBe(true)
    expect(read(other)).toBe(`import { useLanguage } from '../i18n/LanguageContext'
export default function Blank() {
  const { t } = useLanguage()
  return (
    <section>
      <p>Blank</p>
      <h1 className="title">{t.sms.title}</h1>
    </section>
  )
}
`)
  })
})

// ── Fixture 2: nothing in common with test4 (theme context, whole value, aliased key) ──

const THEME = `import { createContext, useContext } from 'react'

const ThemeContext = createContext({ ink: '#222', paper: '#fff' })
const SpacingContext = createContext({ gutter: 12 })

export const useTheme = () => useContext(ThemeContext)
export function useSpacing() {
  return useContext(SpacingContext)
}
`

const RECIPE = `import { useState } from 'react'
import { useSpacing, useTheme } from '../../lib/theme'

type Props = { dish: string; steps: string[] }

export default function RecipeCard({ dish, steps }: Props) {
  const palette = useTheme()
  const { gutter: gap } = useSpacing()
  const [open] = useState(false)
  const servings = 4
  return (
    <article>
      <aside style={{ color: palette.ink, padding: gap }}>Chef's pick</aside>
      <header>{dish}</header>
      <ol>
        {steps.map((step) => (
          <li key={step}>
            <b>{step}</b>
          </li>
        ))}
      </ol>
      <footer>{open ? 'open' : 'closed'}</footer>
      <small>{servings}</small>
    </article>
  )
}
`

describe('lift onto the free canvas — a generic context shape', () => {
  it('carries a whole-value and an aliased destructured hook read, each under its own local name', () => {
    writeFixture('lib/theme.ts', THEME)
    const recipe = writeFixture('src/recipes/RecipeCard.tsx', RECIPE)
    const { moduleFile, result } = lift(recipe, RECIPE, 'aside', true)

    expect(result.ok).toBe(true)
    expect(read(moduleFile)).toBe(`/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
import { useTheme, useSpacing } from '../../lib/theme'

export default function CanvasLayer() {
  const palette = useTheme()
  const { gutter: gap } = useSpacing()
  return (
    <aside style={{ color: palette.ink, padding: gap }}>Chef's pick</aside>
  )
}
`)
    expect(read(recipe)).toBe(RECIPE)
    expect(nameErrors([moduleFile])).toEqual([])
  })

  for (const [what, tag, name] of [
    ['a prop', 'header', 'dish'],
    ['a `.map` row', 'b', 'step'],
    ['a non-context hook (useState)', 'footer', 'open'],
    ['a plain body const', 'small', 'servings'],
  ] as const) {
    it(`still refuses ${what}, writes nothing, and says so in plain words`, () => {
      writeFixture('lib/theme.ts', THEME)
      const recipe = writeFixture('src/recipes/RecipeCard.tsx', RECIPE)
      const { moduleFile, result } = lift(recipe, RECIPE, tag)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.refusal.reason).toBe('captured-scope')
        expect(result.refusal.message).toContain(`"${name}"`)
        expect(result.refusal.message).toContain('Keep it inside its own frame')
      }
      expect(read(recipe)).toBe(RECIPE)
      expect(fs.existsSync(moduleFile)).toBe(false)
    })
  }
})
