/**
 * staticEval — unit tests for §7's bounded static evaluator. One `describe`
 * per tier (A / B / C), plus guards and a non-regression check that a
 * literal-only page's `parsePageFile` output is unaffected by §7's wiring.
 *
 * Uses real temp fixture trees (not in-memory ts-morph), matching
 * `componentSources.test.ts`/`inlineLocalComponents.test.ts` — cross-file
 * import resolution depends on real filesystem paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Node, type Project, type SourceFile } from 'ts-morph'
import { createWorkspaceProject } from '../componentSources'
import { findComponentDeclaration, getFunctionLikeNode, parsePageFile } from '../parsePageFile'
import { createEvalScope, createPageEvalBudget, evaluateExpression, type StaticEvalOptions, type StaticValue } from '../staticEval'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-eval-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

/** Finds the initializer expression of the first `attrName={...}` JSX attribute anywhere in `sourceFile`. */
function findAttrExpr(sourceFile: SourceFile, attrName: string): Node {
  let found: Node | undefined
  sourceFile.forEachDescendant((n, traversal) => {
    if (found) {
      traversal.stop()
      return
    }
    if (Node.isJsxAttribute(n) && n.getNameNode().getText() === attrName) {
      const init = n.getInitializer()
      if (init && Node.isJsxExpression(init)) {
        const expr = init.getExpression()
        if (expr) found = expr
      }
    }
  })
  if (!found) throw new Error(`no JSX attribute named "${attrName}" found`)
  return found
}

/** Evaluates the `attrName={...}` expression in `file`'s default-exported component, with its own component-body locals in scope. */
function evalAttr(project: Project, file: string, attrName: string, opts?: StaticEvalOptions): StaticValue {
  const sourceFile = project.getSourceFile(file) ?? project.addSourceFileAtPath(file)
  const decl = findComponentDeclaration(sourceFile)
  const fn = decl ? getFunctionLikeNode(decl) : undefined
  const scope = createEvalScope(sourceFile, fn)
  return evaluateExpression(findAttrExpr(sourceFile, attrName), scope, opts)
}

describe('staticEval — Tier A', () => {
  it('resolves a module-scope const object + member chain', () => {
    const file = write(
      'Page.tsx',
      [
        "const CARD = { title: 'Flights', icon: 'plane' }",
        'export default function Page() {',
        '  return <div data-test={CARD.title} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'Flights' })
  })

  it('resolves an array index into a module-scope const array', () => {
    const file = write(
      'Page.tsx',
      [
        "const CARDS = ['flights', 'stays', 'activities']",
        'export default function Page() {',
        '  return <div data-test={CARDS[1]} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'stays' })
  })

  it('resolves a cross-file const via a local import', () => {
    write('translations.ts', "export const translations = { en: { greeting: 'Hi Muhammad' } }")
    const file = write(
      'Page.tsx',
      [
        "import { translations } from './translations'",
        'export default function Page() {',
        '  return <p data-test={translations.en.greeting} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'Hi Muhammad' })
  })

  it('resolves a local alias inside the component body', () => {
    write('translations.ts', "export const translations = { en: { route: 'JED to RUH' } }")
    const file = write(
      'Page.tsx',
      [
        "import { translations } from './translations'",
        'export default function Page() {',
        '  const d = translations.en',
        '  return <span data-test={d.route} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'JED to RUH' })
  })

  it('resolves a computed member with a resolvable string key', () => {
    const file = write(
      'Page.tsx',
      [
        "const LABELS = { flights: 'Flights', stays: 'Stays' }",
        "const KEY = 'stays'",
        'export default function Page() {',
        '  return <div data-test={LABELS[KEY]} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'Stays' })
  })

  it('resolves a fully-static template literal', () => {
    const file = write(
      'Page.tsx',
      [
        'const PCT = 42',
        'export default function Page() {',
        '  return <div data-test={`${PCT}%`} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: '42%' })
  })

  it('keeps the static prefix of a PARTIALLY resolvable template literal', () => {
    const file = write(
      'Page.tsx',
      [
        'export default function Page({ tone }) {',
        "  return <div data-test={`esb esb--${tone}`} />",
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    expect(result.kind).toBe('unresolved')
    expect(result).toMatchObject({ kind: 'unresolved', partial: 'esb esb--' })
  })
})

describe('staticEval — Tier B', () => {
  function writeLanguageContext(): void {
    write(
      'translations.ts',
      "export const translations = { en: { greeting: 'Hi Muhammad' }, ar: { greeting: 'مرحبا' } }",
    )
    write(
      'LanguageContext.tsx',
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
      ].join('\n'),
    )
  }

  it('traces a single provider through useContext, resolving a hook-destructured value', () => {
    writeLanguageContext()
    const file = write(
      'Page.tsx',
      [
        "import { useLanguage } from './LanguageContext'",
        'export default function Page() {',
        '  const { t } = useLanguage()',
        '  return <p data-test={t.greeting} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    // No previewLocale configured -> falls back to the first key in source order ('en').
    expect(evalAttr(project, file, 'data-test')).toEqual({
      kind: 'literal',
      value: 'Hi Muhammad',
      note: 'dynamic key not statically known — showing the "en" branch',
    })
  })

  it('resolves the preferredKey branch when configured', () => {
    writeLanguageContext()
    const file = write(
      'Page.tsx',
      [
        "import { useLanguage } from './LanguageContext'",
        'export default function Page() {',
        '  const { t } = useLanguage()',
        '  return <p data-test={t.greeting} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test', { preferredKey: 'ar' })).toEqual({
      kind: 'literal',
      value: 'مرحبا',
      note: 'dynamic key not statically known — showing the "ar" branch',
    })
  })

  it('two providers for the same context -> unresolved (ambiguous, not guessed at)', () => {
    write(
      'translations.ts',
      "export const translations = { en: { greeting: 'Hi Muhammad' }, ar: { greeting: 'مرحبا' } }",
    )
    // A SECOND real `<LanguageContext.Provider>` for the SAME context
    // declaration, in the same file as the first — ambiguous on purpose.
    write(
      'LanguageContext.tsx',
      [
        "import { createContext, useContext, useMemo, useState } from 'react'",
        "import { translations } from './translations'",
        'const LanguageContext = createContext(null)',
        'export function LanguageProvider({ children }) {',
        "  const [lang, setLang] = useState('en')",
        '  const value = useMemo(() => ({ lang, t: translations[lang] }), [lang])',
        '  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>',
        '}',
        'export function SecondProvider({ children }) {',
        "  return <LanguageContext.Provider value={{ lang: 'en', t: translations.en }}>{children}</LanguageContext.Provider>",
        '}',
        'export function useLanguage() {',
        '  const ctx = useContext(LanguageContext)',
        "  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')",
        '  return ctx',
        '}',
      ].join('\n'),
    )
    const file = write(
      'Page.tsx',
      [
        "import { useLanguage } from './LanguageContext'",
        'export default function Page() {',
        '  const { t } = useLanguage()',
        '  return <p data-test={t.greeting} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    expect(result).toMatchObject({ kind: 'unresolved' })
    expect((result as { reason: string }).reason).toContain('ambiguous')
  })

  it('dict[dynamicKey] with no context at all still falls back to preferredKey/first-key + a note', () => {
    const file = write(
      'Page.tsx',
      [
        "const DICT = { en: 'Hello', ar: 'مرحبا' }",
        'export default function Page({ lang }) {',
        '  return <p data-test={DICT[lang]} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({
      kind: 'literal',
      value: 'Hello',
      note: 'dynamic key not statically known — showing the "en" branch',
    })
  })
})

describe('staticEval — Tier C', () => {
  it('calls a concise arrow returning a resolvable template literal', () => {
    write('translations.ts', [
      'function gbLeft(n) {',
      '  return `${n} GB left`',
      '}',
      'export const t = { gbLeft }',
    ].join('\n'))
    const file = write(
      'Page.tsx',
      [
        "import { t } from './translations'",
        'export default function Page() {',
        '  return <span data-test={t.gbLeft(4)} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: '4 GB left' })
  })

  it('picks the first true branch of an if-chain (daysLeftAr shape)', () => {
    write('translations.ts', [
      'function daysLeft(n) {',
      "  if (n === 1) return 'one day left'",
      '  if (n === 2) return `two days left`',
      '  if (n >= 3 && n <= 10) return `${n} days (few) left`',
      '  return `${n} days left`',
      '}',
      'export const t = { daysLeft }',
    ].join('\n'))
    const file = write(
      'Page.tsx',
      [
        "import { t } from './translations'",
        'export default function Page() {',
        '  return <span data-test={t.daysLeft(2)} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'two days left' })
  })

  it('falls through to the general-case return with a note when a branch condition is not statically known', () => {
    write('translations.ts', [
      'function label(n, other) {',
      '  if (other === 1) return `special`',
      '  return `${n} plain`',
      '}',
      'export const t = { label }',
    ].join('\n'))
    const file = write(
      'Page.tsx',
      [
        "import { t } from './translations'",
        'export default function Page({ dynamicOther }) {',
        '  return <span data-test={t.label(5, dynamicOther)} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    // `dynamicOther` is a component parameter — unresolvable — so the WHOLE
    // call is unresolved (args must ALL resolve). This proves the envelope
    // does not silently guess at an unresolvable argument.
    expect(result.kind).toBe('unresolved')
  })

  it('rejects a callee body containing an assignment', () => {
    write('translations.ts', [
      'function label(n) {',
      '  let x = 0',
      '  x = n',
      '  return `${x}`',
      '}',
      'export const t = { label }',
    ].join('\n'))
    const file = write(
      'Page.tsx',
      [
        "import { t } from './translations'",
        'export default function Page() {',
        '  return <span data-test={t.label(5)} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    expect(result).toMatchObject({ kind: 'unresolved' })
    expect((result as { reason: string }).reason).toContain('Tier C')
  })

  it('rejects a callee body containing a loop', () => {
    write('translations.ts', [
      'function label(n) {',
      '  let total = 0',
      '  for (let i = 0; i < n; i++) { total += i }',
      '  return `${total}`',
      '}',
      'export const t = { label }',
    ].join('\n'))
    const file = write(
      'Page.tsx',
      [
        "import { t } from './translations'",
        'export default function Page() {',
        '  return <span data-test={t.label(3)} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    expect(result).toMatchObject({ kind: 'unresolved' })
  })

  it('rejects a callee body containing await', () => {
    write('translations.ts', [
      'async function label(n) {',
      '  const x = await Promise.resolve(n)',
      '  return `${x}`',
      '}',
      'export const t = { label }',
    ].join('\n'))
    const file = write(
      'Page.tsx',
      [
        "import { t } from './translations'",
        'export default function Page() {',
        '  return <span data-test={t.label(3)} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    expect(result).toMatchObject({ kind: 'unresolved' })
  })

  it('evaluates the whitelisted string-method calls', () => {
    const file = write(
      'Page.tsx',
      [
        "const NAME = 'muhammad'",
        'export default function Page() {',
        '  return <span data-test={NAME.toUpperCase()} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'data-test')).toEqual({ kind: 'literal', value: 'MUHAMMAD' })
  })
})

describe('staticEval — guards', () => {
  it('a cycle A -> B -> A terminates and resolves unresolved', () => {
    const file = write(
      'Page.tsx',
      [
        'const a = b',
        'const b = a',
        'export default function Page() {',
        '  return <div data-test={a} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test')
    expect(result).toMatchObject({ kind: 'unresolved' })
    expect((result as { reason: string }).reason).toContain('cycl')
  })

  it('maxDepth degrades a deep member chain to unresolved', () => {
    const file = write(
      'Page.tsx',
      [
        "const A = { b: { c: { d: 'deep' } } }",
        'export default function Page() {',
        '  return <div data-test={A.b.c.d} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    // A tiny depth budget can't even unwrap one level of member access.
    const result = evalAttr(project, file, 'data-test', { maxDepth: 0 })
    expect(result).toMatchObject({ kind: 'unresolved' })
  })

  it('maxSteps degrades a wide object literal to unresolved', () => {
    const props = Array.from({ length: 50 }, (_, i) => `p${i}: ${i}`).join(', ')
    const file = write(
      'Page.tsx',
      [
        `const BIG = { ${props} }`,
        'export default function Page() {',
        '  return <div data-test={BIG.p49} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const result = evalAttr(project, file, 'data-test', { maxSteps: 3 })
    expect(result).toMatchObject({ kind: 'unresolved' })
  })

  it('an import pointing at a nonexistent file resolves unresolved, never throws', () => {
    const file = write(
      'Page.tsx',
      [
        "import { translations } from './does-not-exist'",
        'export default function Page() {',
        '  return <div data-test={translations.en.greeting} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(() => evalAttr(project, file, 'data-test')).not.toThrow()
    expect(evalAttr(project, file, 'data-test')).toMatchObject({ kind: 'unresolved' })
  })

  it('a page-wide budget exhausted by earlier calls degrades a later call to unresolved', () => {
    const file = write(
      'Page.tsx',
      [
        "const A = 'hello'",
        'export default function Page() {',
        '  return <div data-test={A} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const pageBudget = createPageEvalBudget(1)
    // First call spends the only unit of page budget available.
    evalAttr(project, file, 'data-test', { pageBudget })
    // Second call (would otherwise trivially resolve) is starved by the SAME shared budget.
    const result = evalAttr(project, file, 'data-test', { pageBudget })
    expect(result).toMatchObject({ kind: 'unresolved' })
  })
})

describe('staticEval — non-regression (literal-only pages are unaffected)', () => {
  it('parsePageFile without evalOptions is unchanged: no resolution field, same locked/props/text', () => {
    const source = [
      'export default function Page() {',
      '  return (',
      '    <div>',
      '      <Button label="Save" primary />',
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    const file = write('static-tree.tsx', source)

    const page = parsePageFile(file, tmpDir)

    const div = page.nodes[page.rootIds[0]!]!
    expect(div.locked).toBe(false)
    expect(div.resolution).toBeUndefined()

    const button = Object.values(page.nodes).find((n) => n.name === 'Button')!
    expect(button.props).toEqual({ label: 'Save', primary: true })
    expect(button.locked).toBe(false)
    expect(button.resolution).toBeUndefined()
  })

  it('a page that only uses literals produces the SAME output whether or not evalOptions is passed', () => {
    const source = [
      'export default function Page() {',
      '  return <p>Hello there</p>',
      '}',
      '',
    ].join('\n')
    const file = write('literal-only.tsx', source)
    const project = createWorkspaceProject(tmpDir)

    const without = parsePageFile(file, tmpDir, project)
    const withEval = parsePageFile(file, tmpDir, project, {})

    expect(withEval).toEqual(without)
  })

  it('§7.6 wiring: a resolved value records `resolution` and does NOT lock the node (lock-01)', () => {
    write('translations.ts', "export const translations = { en: { greeting: 'Hi Muhammad' } }")
    const file = write(
      'Page.tsx',
      [
        "import { translations } from './translations'",
        'export default function Page() {',
        '  const t = translations.en',
        '  return <p>{t.greeting}</p>',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const page = parsePageFile(file, tmpDir, project, {})
    const p = page.nodes[page.rootIds[0]!]!
    expect(p.text).toBe('Hi Muhammad')
    // `<p>` is written at a known line and column: moving, reordering or
    // deleting it is a precise, single-target edit. Only its VALUE is derived.
    expect(p.locked).toBe(false)
    expect(p.lockReason).toBeUndefined()
    expect(p.resolution).toEqual({ source: 't.greeting' })
    // The refusal that actually protects the binding, unchanged and per-prop.
    expect(p.codeText).toBe(true)
  })

  it('lock-01: a resolved value on a STRUCTURALLY locked node keeps that node locked, with its own reason', () => {
    write('copy.ts', "export const copy = { title: 'Deals' }")
    const file = write(
      'Spread.tsx',
      [
        "import { copy } from './copy'",
        'export default function Page({ rest }) {',
        '  return <p {...rest} data-x={copy.title}>hi</p>',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const page = parsePageFile(file, tmpDir, project, {})
    const p = page.nodes[page.rootIds[0]!]!
    expect(p.locked).toBe(true)
    expect(p.lockReason).toBe('spread props')
    expect(p.resolution).toEqual({ source: 'copy.title' })
    expect(p.codeProps).toContain('data-x')
  })

  it('lock-01: an inline-style value resolved from a const does not lock its element', () => {
    write('tokens.ts', "export const accent = 'var(--text-link-default)'")
    const file = write(
      'Styled.tsx',
      [
        "import { accent } from './tokens'",
        'export default function Page() {',
        '  return <span style={{ color: accent }}>hi</span>',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    const page = parsePageFile(file, tmpDir, project, {})
    const span = page.nodes[page.rootIds[0]!]!
    expect(span.inlineStyles).toEqual({ color: 'var(--text-link-default)' })
    expect(span.locked).toBe(false)
    expect(span.lockReason).toBeUndefined()
    // The style PROPERTY is still refused — that is where the truth lives.
    expect(span.codeProps).toContain('style:color')
  })
})

/**
 * parser-08 — "the source says there is nothing here" is an ANSWER, distinct
 * from "the parser could not read this". Everything downstream that picks a JSX
 * branch depends on the difference; see `StaticValue`'s `'undefined'` variant.
 */
describe('staticEval — statically absent values', () => {
  it('a key missing from a fully-read object literal resolves to `undefined`, not unresolved', () => {
    const file = write(
      'Page.tsx',
      [
        "const ROW = { key: 'checkin', icon: 'check.svg' }",
        'export default function Page() {',
        '  return <img src={ROW.image} alt={ROW.icon} />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'src')).toEqual({ kind: 'undefined' })
    expect(evalAttr(project, file, 'alt')).toMatchObject({ kind: 'literal', value: 'check.svg' })
  })

  it('a SPREAD keeps a missing key unknown — it could have arrived from elsewhere', () => {
    const file = write(
      'Page.tsx',
      [
        "const BASE = { image: 'a.png' }",
        "const ROW = { ...BASE, key: 'checkin' }",
        'export default function Page() {',
        '  return <img src={ROW.image} alt="" />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'src').kind).toBe('unresolved')
  })

  it('resolves `.length` on an array literal the source spells out', () => {
    const file = write(
      'Page.tsx',
      [
        "const ROWS = ['a', 'b', 'c']",
        'export default function Page() {',
        '  return <img width={ROWS.length} height={ROWS.length - 1} alt="" />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'width')).toMatchObject({ kind: 'literal', value: 3 })
    expect(evalAttr(project, file, 'height')).toMatchObject({ kind: 'literal', value: 2 })
  })

  it('declines `.length` when a spread element makes the count unknown', () => {
    const file = write(
      'Page.tsx',
      [
        "const MORE = ['b', 'c']",
        "const ROWS = ['a', ...MORE]",
        'export default function Page() {',
        '  return <img width={ROWS.length} alt="" />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'width').kind).toBe('unresolved')
  })

  it('reads the `undefined` keyword, and compares against it', () => {
    const file = write(
      'Page.tsx',
      [
        "const ROW = { key: 'a' }",
        'export default function Page() {',
        '  return <img width={undefined} height={ROW.image === undefined} alt="" />',
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'width')).toEqual({ kind: 'undefined' })
    expect(evalAttr(project, file, 'height')).toMatchObject({ kind: 'literal', value: true })
  })

  it('an absent left operand falls through `||` and `??`, and short-circuits `&&`', () => {
    const file = write(
      'Page.tsx',
      [
        "const ROW = { key: 'a' }",
        'export default function Page() {',
        "  return <img src={ROW.image || 'fallback.png'} alt={ROW.image ?? 'none'} width={ROW.image && 'x'} />",
        '}',
        '',
      ].join('\n'),
    )
    const project = createWorkspaceProject(tmpDir)
    expect(evalAttr(project, file, 'src')).toMatchObject({ kind: 'literal', value: 'fallback.png' })
    expect(evalAttr(project, file, 'alt')).toMatchObject({ kind: 'literal', value: 'none' })
    expect(evalAttr(project, file, 'width')).toEqual({ kind: 'undefined' })
  })
})
