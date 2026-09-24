/**
 * P3-C (WB-18) — a class ADD lands on a `className` this codemod cannot read
 * into, and a CSS Module the file does not import yet is imported after the
 * batch, instead of refusing `unsupported-expression`/`unsupported-call`/
 * `css-module-import-missing`.
 *
 * What still refuses is tested here too: a REMOVE from a wrapped shape (no text
 * in the file holds the token), a `className` that is not a class string at
 * all, and a refused edit never reserves an import.
 *
 * The fixture is a recipe app and shares nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPageEvalBudget, createWorkspaceProject, parsePageFile } from '@core/page-parser'
import { createModuleImportPlan } from '../cssModuleImportPlan'
import { setJsxClassName, type ClassNameToken } from '../setJsxClassName'
import { locateTag } from './fixtureLocation'

const t = (...tokens: string[]): ClassNameToken[] => tokens.map((token) => ({ kind: 'literal', token }))
const mod = (specifier: string, local: string): ClassNameToken => ({ kind: 'module', specifier, local })

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classname-wrap-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function fixture(source: string): { file: string; line: number; col: number } {
  const file = path.join(tmpDir, 'RecipeCard.tsx')
  fs.writeFileSync(file, source, 'utf8')
  return { file, ...locateTag(source, 'article') }
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

describe('setJsxClassName — wrapping an expression on ADD', () => {
  it("uses the file's own join helper when one is in scope", () => {
    const source = [
      "import { clsx } from 'clsx'",
      'export function RecipeCard({ tone }: { tone?: string }) {',
      '  return <article className={clsx(tone)}>Soup</article>',
      '}',
      'export function Plain({ tone }: { tone?: string }) {',
      '  return <section className={tone}>Stew</section>',
      '}',
      '',
    ].join('\n')
    const file = path.join(tmpDir, 'RecipeCard.tsx')
    fs.writeFileSync(file, source, 'utf8')
    const at = locateTag(source, 'section')

    expect(setJsxClassName({ file, ...at, add: t('featured'), remove: t() }).ok).toBe(true)
    expect(read(file)).toBe(source.replace('className={tone}', 'className={clsx(tone, "featured")}'))
  })

  it('parenthesises a logical before the fallback', () => {
    const source = "export const RecipeCard = ({ hot }: { hot: boolean }) => <article className={hot && 'spicy'}>Chili</article>\n"
    const at = fixture(source)
    expect(setJsxClassName({ ...at, add: t('featured'), remove: t() }).ok).toBe(true)
    expect(read(at.file)).toBe(source.replace("{hot && 'spicy'}", "{`featured ${(hot && 'spicy') || ''}`}"))
  })

  it('is idempotent — re-sending the same ADD changes nothing', () => {
    const source = 'export const RecipeCard = ({ tone }: { tone?: string }) => <article className={tone}>Soup</article>\n'
    const at = fixture(source)
    expect(setJsxClassName({ ...at, add: t('featured'), remove: t() }).ok).toBe(true)
    const once = read(at.file)
    expect(setJsxClassName({ ...at, add: t('featured'), remove: t() }).ok).toBe(true)
    expect(read(at.file)).toBe(once)
  })

  it('refuses a className that is not a class string at all', () => {
    const source = 'export const RecipeCard = () => <article className={() => "x"}>Soup</article>\n'
    const at = fixture(source)
    const result = setJsxClassName({ ...at, add: t('featured'), remove: t() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('unsupported-expression')
    expect(read(at.file)).toBe(source)
  })

  it('the added class survives the NEXT parse — it sits in the static prefix the parser keeps', () => {
    const source = [
      'export default function RecipeCard({ tone }: { tone?: string }) {',
      '  return <article className={tone}>Soup</article>',
      '}',
      '',
    ].join('\n')
    const at = fixture(source)
    expect(setJsxClassName({ ...at, add: t('featured'), remove: t() }).ok).toBe(true)

    const parsed = parsePageFile(at.file, tmpDir, createWorkspaceProject(tmpDir), {
      pageBudget: createPageEvalBudget(),
      workspaceRoot: tmpDir,
    })
    const article = Object.values(parsed.nodes).find((node) => node.props?.className !== undefined)
    expect(String(article?.props?.className ?? '').split(/\s+/)).toContain('featured')
  })
})

describe('setJsxClassName — a CSS Module the file does not import yet (batch plan)', () => {
  it('writes the binding now and the import after the batch, with exact bytes', () => {
    const source = ['export function RecipeCard() {', '  return <article className="card">Soup</article>', '}', ''].join('\n')
    const at = fixture(source)
    const plan = createModuleImportPlan()

    const result = setJsxClassName({
      ...at,
      add: [mod('./RecipeCard.module.css', 'hero')],
      remove: [],
      pendingModuleImports: plan.forFile(at.file),
    })
    expect(result.ok).toBe(true)
    // No line was added mid-batch — every pending position in the file still holds.
    expect(read(at.file)).toBe(source.replace('className="card"', 'className={`card ${styles.hero}`}'))

    expect(plan.apply()).toEqual({ written: [at.file], failed: [] })
    expect(read(at.file)).toBe(
      "import styles from './RecipeCard.module.css'\n" + source.replace('className="card"', 'className={`card ${styles.hero}`}'),
    )
  })

  it('never reserves a name the component already uses, even as a parameter', () => {
    const source = [
      'export function RecipeCard({ styles }: { styles: string }) {',
      '  return <article className={styles}>Soup</article>',
      '}',
      '',
    ].join('\n')
    const at = fixture(source)
    const plan = createModuleImportPlan()
    const pending = plan.forFile(at.file)

    expect(setJsxClassName({ ...at, add: [mod('./RecipeCard.module.css', 'hero')], remove: [], pendingModuleImports: pending }).ok).toBe(true)
    plan.apply()
    expect(read(at.file)).toBe(
      "import styles2 from './RecipeCard.module.css'\n" +
        source.replace('className={styles}', "className={`${styles2.hero} ${styles || ''}`}"),
    )
  })

  it('reserves a distinct binding per stylesheet in one edit', () => {
    const source = ['export function RecipeCard() {', '  return <article>Soup</article>', '}', ''].join('\n')
    const at = fixture(source)
    const plan = createModuleImportPlan()

    const result = setJsxClassName({
      ...at,
      add: [mod('./RecipeCard.module.css', 'hero'), mod('./shared/layout.module.css', 'stack')],
      remove: [],
      pendingModuleImports: plan.forFile(at.file),
    })
    expect(result.ok).toBe(true)
    plan.apply()
    expect(read(at.file)).toBe(
      [
        "import styles from './RecipeCard.module.css'",
        "import styles2 from './shared/layout.module.css'",
        'export function RecipeCard() {',
        '  return <article className={`${styles.hero} ${styles2.stack}`}>Soup</article>',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('a refused edit reserves nothing, so no unused import is ever added', () => {
    const source = 'export const RecipeCard = ({ tone }: { tone?: string }) => <article className={tone}>Soup</article>\n'
    const at = fixture(source)
    const plan = createModuleImportPlan()

    const result = setJsxClassName({
      ...at,
      add: [mod('./RecipeCard.module.css', 'hero')],
      remove: t('old'),
      pendingModuleImports: plan.forFile(at.file),
    })
    expect(result.ok).toBe(false)
    expect(plan.apply()).toEqual({ written: [], failed: [] })
    expect(read(at.file)).toBe(source)
  })

  it('copies the file’s quote style and line ending onto the import', () => {
    const source = ['import { useState } from "react"', 'export function RecipeCard() {', '  return <article>Soup</article>', '}', ''].join('\r\n')
    const at = fixture(source)
    const plan = createModuleImportPlan()
    expect(setJsxClassName({ ...at, add: [mod('./RecipeCard.module.css', 'hero')], remove: [], pendingModuleImports: plan.forFile(at.file) }).ok).toBe(true)
    plan.apply()
    expect(read(at.file).startsWith('import { useState } from "react"\r\nimport styles from "./RecipeCard.module.css"\r\nexport function')).toBe(true)
  })
})
