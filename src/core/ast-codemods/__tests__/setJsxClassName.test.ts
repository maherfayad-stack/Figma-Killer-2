import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setJsxClassName, type ClassNameToken } from '../setJsxClassName'
import { locateTag } from './fixtureLocation'

/** Plain class tokens — the ordinary shape. `mod()` below is the CSS-Modules one. */
const t = (...tokens: string[]): ClassNameToken[] => tokens.map((token) => ({ kind: 'literal', token }))

/** A CSS-Modules token: the class as written in `specifier`, attached as `styles.<local>`. */
const mod = (specifier: string, local: string): ClassNameToken => ({ kind: 'module', specifier, local })

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

      const result = setJsxClassName({ file, line, col, add: t('a', 'b'), remove: t() })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className="a b"')
    })

    it('is a no-op when there is nothing to add and no attribute exists', () => {
      const source = ['export function App() {', '  return <div>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('remove-absent.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t(), remove: t('ghost') })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('plain string literal — className="a b"', () => {
    it('adds and removes tokens in place', () => {
      const source = ['export function App() {', '  return <div className="a b c">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('literal-merge.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('d'), remove: t('b') })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className="a c d"')
    })

    it('is the Tailwind fill-swap shape: one utility class out, another in', () => {
      const source = ['export function App() {', '  return <div className="rounded bg-red-500">Hi</div>', '}', ''].join(
        '\n',
      )
      const file = writeFixture('tailwind-swap.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('bg-blue-600'), remove: t('bg-red-500') })

      expect(result.ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain('className="rounded bg-blue-600"')
      expect(written).not.toContain('bg-red-500')
    })

    it('removes the whole attribute when the merge result is empty', () => {
      const source = ['export function App() {', '  return <div className="only">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('literal-empty.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t(), remove: t('only') })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).not.toContain('className')
    })

    it('preserves single-quote style already used in the file', () => {
      const source = ["export function App() {", "  return <div className='a b'>Hi</div>", '}', ''].join('\n')
      const file = writeFixture('literal-single-quote.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('c'), remove: t() })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain("className='a b c'")
    })

    it('no-ops when nothing actually changes (idempotent)', () => {
      const source = ['export function App() {', '  return <div className="a b">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('literal-noop.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('a'), remove: t('not-there') })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('expression-wrapped static string — className={"a b"} / className={`a b`}', () => {
    it('merges tokens inside a string literal expression container', () => {
      const source = ['export function App() {', '  return <div className={"a b"}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('expr-string.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('c'), remove: t('a') })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={"b c"}')
    })

    it('merges tokens inside a no-substitution template literal', () => {
      const source = ['export function App() {', '  return <div className={`a b`}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('expr-template.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('c'), remove: t() })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`a b c`}')
    })
  })

  describe('dynamic template literal — className={`a ${x}`}', () => {
    it('appends an ADD to the static head only, leaving the interpolation untouched', () => {
      const source = ['export function App() {', '  return <div className={`a ${x}`}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('template-add.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('b'), remove: t() })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`a b ${x}`}')
    })

    it('refuses template-dynamic when asked to remove a token', () => {
      const source = ['export function App() {', '  return <div className={`a ${x}`}>Hi</div>', '}', ''].join('\n')
      const file = writeFixture('template-remove.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t(), remove: t('a') })

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

      const result = setJsxClassName({ file, line, col, add: t('c'), remove: t() })

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

      const result = setJsxClassName({ file, line, col, add: t('extra'), remove: t() })

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

      const result = setJsxClassName({ file, line, col, add: t(), remove: t('b') })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain("cn('a c', x)")
    })

    it('removes the whole literal argument once it becomes empty', () => {
      const source = ['export function App() {', "  return <div className={cn('only', x)}>Hi</div>", '}', ''].join(
        '\n',
      )
      const file = writeFixture('cn-remove-all.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t(), remove: t('only') })

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

      const result = setJsxClassName({ file, line, col, add: t('b'), remove: t() })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('unsupported-call')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })
  })

  describe('CSS Modules binding — className={styles.card}', () => {
    // ADD used to refuse here too. That was over-application of a rule about
    // DECLARATIONS to a question about ATTACHMENT, and it made every element
    // on an agent-authored page (which is every element — the agent writes
    // `.module.css` for everything) unable to take a class at all.
    it('ADDS a token by wrapping the binding in a template literal', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('css-module.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t('x'), remove: t() })

      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`${styles.card} x`}')
    })

    it('adds several tokens at once, and never introduces a newline', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('css-module-multi.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: t('x', 'y'), remove: t() }).ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain('className={`${styles.card} x y`}')
      // Node ids are `rel:line:col`; a newline here would shift every node
      // below this one in the same file.
      expect(written.split('\n').length).toBe(source.split('\n').length)
    })

    it('still refuses to REMOVE a token the module produces', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('css-module-remove.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: t(), remove: t('card') })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('css-module-binding')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })

    it('is a no-op when there is nothing to add or remove', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('css-module-noop.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: t(), remove: t() }).ok).toBe(true)
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

      const result = setJsxClassName({ file, line, col, add: t('x'), remove: t() })

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

      const result = setJsxClassName({ file, line, col, add: t('x'), remove: t() })

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

      const result = setJsxClassName({ file, line, col, add: t('x'), remove: t() })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('unsupported-expression')
    })
  })

  // `style-02`. A class declared in a `*.module.css` has no literal name in
  // the built app — the bundler hashes it. Writing Studio's own compiled hash
  // as a plain token produced markup that styles nothing outside Studio's
  // canvas, which is the bug these tests exist to keep fixed.
  describe('module tokens — a CSS-Modules class is a binding, never a string', () => {
    it('writes the member expression, not the class name, onto a bare element', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-bare.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] })

      expect(result.ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain('className={styles.row}')
      // The hash `styleCompile.ts` computes for the canvas must never appear.
      expect(written).not.toContain('Card_row__')
    })

    it('uses whatever local binding the file actually chose, not a hardcoded `styles`', () => {
      const source = [
        "import css from './Card.module.css'",
        'export function Card() {',
        '  return <div className="wrap">Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-alias.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] }).ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`wrap ${css.row}`}')
    })

    it('bracket-indexes a local name that is not a JS identifier', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-kebab.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'card-row')], remove: [] }).ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={styles["card-row"]}')
    })

    it('gives an existing side-effect import a binding in place — no new line', () => {
      const source = [
        "import './Card.module.css'",
        'export function Card() {',
        '  return <div>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-side-effect.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] }).ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain("import styles from './Card.module.css'")
      expect(written).toContain('className={styles.row}')
      expect(written.split('\n').length).toBe(source.split('\n').length)
    })

    // The refusal, not the convenience. Adding the import would insert a line
    // at the top of the file and move every other pending edit in the batch.
    it('REFUSES css-module-import-missing when the file does not import the stylesheet', () => {
      const source = ['export function Card() {', '  return <div className="wrap">Hi</div>', '}', ''].join('\n')
      const file = writeFixture('module-no-import.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.refusal.reason).toBe('css-module-import-missing')
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })

    it('does not add a binding on a refusal path (the file is left byte-identical)', () => {
      const source = [
        "import './Card.module.css'",
        'export function Card({ dynamicClass }) {',
        '  return <div className={dynamicClass}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-refusal-no-bind.tsx', source)
      const { line, col } = locateTag(source, 'div')

      const result = setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] })

      expect(result.ok).toBe(false)
      expect(fs.readFileSync(file, 'utf8')).toBe(source)
    })

    it('appends a module token to an existing binding without dropping it', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-append.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] }).ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('className={`${styles.card} ${styles.row}`}')
    })

    it('removes the whole attribute when the module token IS the entire className', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-remove-whole.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [], remove: [mod('./Card.module.css', 'card')] }).ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).not.toContain('className')
    })

    it('removes a module token that is one argument of a cn() join', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card({ x }) {',
        '  return <div className={cn(styles.card, x)}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-remove-cn.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [], remove: [mod('./Card.module.css', 'card')] }).ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain('cn(x)')
    })

    it('adds a module token to a cn() join as its own argument', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card({ x }) {',
        "  return <div className={cn('base', x)}>Hi</div>",
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-add-cn.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] }).ok).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toContain("cn('base', x, styles.row)")
    })

    it('is idempotent — re-sending the same module add rewrites nothing', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card({ x }) {',
        "  return <div className={cn('base', x)}>Hi</div>",
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-idempotent.tsx', source)
      const { line, col } = locateTag(source, 'div')

      setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] })
      const afterFirst = fs.readFileSync(file, 'utf8')
      setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] })
      expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst)
    })

    it('appends a module span to a dynamic template without touching the interpolation', () => {
      const source = [
        "import styles from './Card.module.css'",
        'export function Card({ x }) {',
        '  return <div className={`base ${x}`}>Hi</div>',
        '}',
        '',
      ].join('\n')
      const file = writeFixture('module-template.tsx', source)
      const { line, col } = locateTag(source, 'div')

      expect(setJsxClassName({ file, line, col, add: [mod('./Card.module.css', 'row')], remove: [] }).ok).toBe(true)
      const written = fs.readFileSync(file, 'utf8')
      expect(written).toContain('className={`base ${x} ${styles.row}`}')
      expect(written.split('\n').length).toBe(source.split('\n').length)
    })
  })

  it('is idempotent: applying the same add twice yields identical file content', () => {
    const source = ['export function App() {', '  return <div className="a">Hi</div>', '}', ''].join('\n')
    const file = writeFixture('idempotent.tsx', source)
    const { line, col } = locateTag(source, 'div')

    setJsxClassName({ file, line, col, add: t('b'), remove: t() })
    const afterFirst = fs.readFileSync(file, 'utf8')

    setJsxClassName({ file, line, col, add: t('b'), remove: t() })
    const afterSecond = fs.readFileSync(file, 'utf8')

    expect(afterSecond).toBe(afterFirst)
  })

  it('throws a clear error when no JSX element exists at the location', () => {
    const source = 'export const x = 1\n'
    const file = writeFixture('no-element.tsx', source)

    expect(() => setJsxClassName({ file, line: 1, col: 1, add: t('a'), remove: t() })).toThrow(/No JSX element found/)
  })
})
