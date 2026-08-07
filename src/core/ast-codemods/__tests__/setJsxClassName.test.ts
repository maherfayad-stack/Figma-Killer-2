import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setJsxClassName } from '../setJsxClassName'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-codemods-classname-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpDir, name)
  fs.writeFileSync(filePath, source, 'utf8')
  return filePath
}

describe('setJsxClassName', () => {
  describe('absent className', () => {
    it('creates a className attribute when adding tokens', () => {
      const source = ['export function App() {', '  return <div>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('add-absent.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['a', 'b'], remove: [] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className="a b"')
    })

    it('is a no-op when there is nothing to add and no attribute exists', () => {
      const source = ['export function App() {', '  return <div>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('remove-absent.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [], remove: ['ghost'] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('plain string literal — className="a b"', () => {
    it('adds and removes tokens in place', () => {
      const source = ['export function App() {', '  return <div className="a b c">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('literal-merge.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['d'], remove: ['b'] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className="a c d"')
    })

    it('is the Tailwind fill-swap shape: one utility class out, another in', () => {
      const source = ['export function App() {', '  return <div className="rounded bg-red-500">Hi</div>', '}', ''].join(
        '\n',
      )
      const file = writeFixture('tailwind-swap.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['bg-blue-600'], remove: ['bg-red-500'] })

      expect(result.ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain('className="rounded bg-blue-600"')
      expect(written).not.toContain('bg-red-500')
    })

    it('removes the whole attribute when the merge result is empty', () => {
      const source = ['export function App() {', '  return <div className="only">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('literal-empty.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [], remove: ['only'] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).not.toContain('className')
    })

    it('preserves single-quote style already used in the file', () => {
      const source = ["export function App() {", "  return <div className='a b'>Hi</div>", '}', ''].join('\n')
      const file = writeFixture('literal-single-quote.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['c'], remove: [] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain("className='a b c'")
    })

    it('no-ops when nothing actually changes (idempotent)', () => {
      const source = ['export function App() {', '  return <div className="a b">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('literal-noop.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['a'], remove: ['not-there'] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('expression-wrapped static string — className={"a b"} / className={`a b`}', () => {
    it('merges tokens inside a string literal expression container', () => {
      const source = ['export function App() {', '  return <div className={"a b"}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('expr-string.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['c'], remove: ['a'] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={"b c"}')
    })

    it('merges tokens inside a no-substitution template literal', () => {
      const source = ['export function App() {', '  return <div className={`a b`}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('expr-template.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['c'], remove: [] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`a b c`}')
    })
  })

  describe('dynamic template literal — className={`a ${x}`}', () => {
    it('appends an ADD to the static head only, leaving the interpolation untouched', () => {
      const source = ['export function App() {', '  return <div className={`a ${x}`}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('template-add.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['b'], remove: [] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`a b ${x}`}')
    })

    it('refuses template-dynamic when asked to remove a token', () => {
      const source = ['export function App() {', '  return <div className={`a ${x}`}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('template-remove.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [], remove: ['a'] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('template-dynamic')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('class-name-join call — className={cn(...)} / clsx / classNames / classnames', () => {
    it('merges an ADD into an existing literal string argument', () => {
      const source = ['export function App() {', "  return <div className={cn('a b', x)}>Hi</div>", '}', ''].join(
        '\n',
      )
      const file = writeFixture('cn-merge.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['c'], remove: [] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain("cn('a b c', x)")
    })

    it('appends a brand-new literal argument when no literal argument exists yet', () => {
      const source = [
        'export function App() {',
        "  return <div className={clsx(styles.card, isActive && 'active')}>Hi</div>",
        '}',
        '',
      ].join('\n')
      const file = writeFixture('cn-append.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['extra'], remove: [] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain(
        'clsx(styles.card, isActive && \'active\', "extra")',
      )
    })

    it('removes a token from a literal string argument', () => {
      const source = ['export function App() {', "  return <div className={cn('a b c', x)}>Hi</div>", '}', ''].join(
        '\n',
      )
      const file = writeFixture('cn-remove.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [], remove: ['b'] })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain("cn('a c', x)")
    })

    it('removes the whole literal argument once it becomes empty', () => {
      const source = ['export function App() {', "  return <div className={cn('only', x)}>Hi</div>", '}', ''].join(
        '\n',
      )
      const file = writeFixture('cn-remove-all.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [], remove: ['only'] })

      expect(result.ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain('cn(x)')
      expect(written).not.toContain('only')
    })

    it('refuses unsupported-call for a function call not in the class-name-join whitelist', () => {
      const source = ['export function App() {', "  return <div className={someFn('a')}>Hi</div>", '}', ''].join(
        '\n',
      )
      const file = writeFixture('unsupported-call.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['b'], remove: [] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('unsupported-call')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('CSS Modules binding — className={styles.card}', () => {
    it('refuses css-module-binding when the identifier is a default import from a *.module.css file', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('css-module.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['x'], remove: [] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('css-module-binding')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })

    it('falls back to the generic refusal for a member access that is NOT a CSS Modules import', () => {
      const source = [
        'export function Card({ theme }) {',
        '  return <div className={theme.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('non-css-module-member.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['x'], remove: [] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('unsupported-expression')
    })
  })

  describe('other unsupported expressions', () => {
    it('refuses unsupported-expression for a bare identifier', () => {
      const source = [
        'export function App({ dynamicClass }) {',
        '  return <div className={dynamicClass}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('identifier.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['x'], remove: [] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('unsupported-expression')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })

    it('refuses unsupported-expression for a ternary', () => {
      const source = [
        'export function App({ active }) {',
        "  return <div className={active ? 'a' : 'b'}>Hi</div>",
        '}',
        '',
      ].join('\n')
      const file = writeFixture('ternary.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: ['x'], remove: [] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('unsupported-expression')
    })
  })

  it('is idempotent: applying the same add twice yields identical file content', () => {
    const source = ['export function App() {', '  return <div className="a">Hi</div>', '}', ''].join('\n')
    const file = writeFixture('idempotent.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxClassName({ file, line, col, add: ['b'], remove: [] })
    const afterFirst = fs.readFileSync(file, 'utf8')

    setJsxClassName({ file, line, col, add: ['b'], remove: [] })
    const afterSecond = fs.readFileSync(file, 'utf8')

    expect(afterSecond).toBe(afterFirst)
  })

  it('throws a clear error when no JSX element exists at the location', () => {
    const source = 'export const x = 1\n'
    const file = writeFixture('no-element.tsx', source)

    expect(() => setJsxClassName({ file, line: 1, col: 1, add: ['a'], remove: [] })).toThrow(/No JSX element found/)
  })
})
