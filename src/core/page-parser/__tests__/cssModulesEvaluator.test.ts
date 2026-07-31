/**
 * WS-2.2 — `import styles from './Card.module.css'` then `className={styles.card}`.
 *
 * The evaluator already resolves member chains off a resolved object; it just
 * had no value for `styles`. `resolveCssModuleImport` (`../assetImports.ts`)
 * teaches `resolveIdentifier` one more "an import with no `SourceFile`" case,
 * fed from a `moduleClassMaps` lookup exactly shaped like
 * `server/handlers/studio/styleCompile.ts`'s `CompiledStyles.moduleClassMaps`
 * — this suite builds that lookup by hand rather than running the real
 * compiler, since THAT wiring belongs to `styleCompile.test.ts`.
 *
 * Also covers the WS-2.2 `cn`/`clsx`/`classnames` Tier C built-in, added
 * specifically so a CSS-Modules-shaped `cn(styles.card, isOn && styles.on)`
 * resolves instead of going dark the moment a project reaches for the
 * ubiquitous conditional-class idiom.
 */
import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createPageEvalBudget,
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ParsedNode,
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-modules-eval-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

const CARD_CLASS_MAPS: Record<string, Record<string, string>> = {
  'components/Card.module.css': { card: 'Card_card__a1b2', on: 'Card_on__c3d4' },
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir, cssModuleClassMaps: CARD_CLASS_MAPS }
}

/** No `cssModuleClassMaps` configured at all — the "compile step never ran" case. */
function evalOptionsWithoutCssModules(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

function loadNodes(pageRel: string, opts: StaticEvalOptions | undefined): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  const expanded = inlineLocalComponents(parsed, sources, project, tmpDir, opts ? { evalOptions: opts } : {})
  return Object.values(expanded.nodes)
}

function writeCardModuleFixture(): void {
  write('components/Card.module.css', '.card { display: flex }\n.on { opacity: 1 }\n')
}

describe('CSS Modules through the evaluator', () => {
  it('resolves styles.card to its hashed global class name', () => {
    writeCardModuleFixture()
    write(
      'pages/Home.jsx',
      [
        "import styles from '../components/Card.module.css'",
        'export default function Home() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )

    const div = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'div')
    expect(div?.props.className).toBe('Card_card__a1b2')
  })

  it('resolves a template literal built from a CSS Modules class', () => {
    writeCardModuleFixture()
    write(
      'pages/Home.jsx',
      [
        "import styles from '../components/Card.module.css'",
        'export default function Home() {',
        '  return <div className={`${styles.card} active`}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )

    const div = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'div')
    expect(div?.props.className).toBe('Card_card__a1b2 active')
  })

  it('resolves cn(styles.card, isOn && styles.on) — both branches statically known', () => {
    writeCardModuleFixture()
    write(
      'pages/Home.jsx',
      [
        "import styles from '../components/Card.module.css'",
        "function cn() { return 'DECOY' }", // a same-named local — proves the built-in never calls it
        'const isOn = true',
        'export default function Home() {',
        '  return <div className={cn(styles.card, isOn && styles.on)}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )

    const div = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'div')
    expect(div?.props.className).toBe('Card_card__a1b2 Card_on__c3d4')
  })

  it('drops an unresolvable cn() argument instead of failing the whole join', () => {
    writeCardModuleFixture()
    write(
      'pages/Home.jsx',
      [
        "import styles from '../components/Card.module.css'",
        'export default function Home({ isOn }) {',
        '  return <div className={cn(styles.card, isOn && styles.on)}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )

    // `isOn` is an unresolvable prop, so `isOn && styles.on` is unresolved and
    // dropped — `styles.card` still contributes. Never all-or-nothing.
    const div = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'div')
    expect(div?.props.className).toBe('Card_card__a1b2')
  })

  it('leaves the import unresolved without a configured moduleClassMaps', () => {
    writeCardModuleFixture()
    write(
      'pages/Home.jsx',
      [
        "import styles from '../components/Card.module.css'",
        'export default function Home() {',
        '  return <div className={styles.card}>Hi</div>',
        '}',
        '',
      ].join('\n'),
    )

    const div = loadNodes('pages/Home.jsx', evalOptionsWithoutCssModules()).find((n) => n.name === 'div')
    expect(div?.props.className).toBeUndefined()
  })

  it('resolves through a component prop, the same way a raw SVG import does', () => {
    writeCardModuleFixture()
    write(
      'components/Card.jsx',
      [
        "import styles from './Card.module.css'",
        'export default function Card({ children }) {',
        '  return <section className={styles.card}>{children}</section>',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'pages/Home.jsx',
      [
        "import Card from '../components/Card'",
        'export default function Home() {',
        '  return <Card>Hi</Card>',
        '}',
        '',
      ].join('\n'),
    )

    const section = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'section')
    expect(section?.props.className).toBe('Card_card__a1b2')
  })
})

describe('cn/clsx/classnames Tier C built-in', () => {
  it('keeps truthy strings, drops falsy scalars, across all three names', () => {
    write(
      'pages/Home.jsx',
      [
        'export default function Home() {',
        '  return (',
        '    <div>',
        "      <a className={cn('a', false, 0, null, undefined, 'b')}>cn</a>",
        "      <b className={clsx('x', '' , 'y')}>clsx</b>",
        "      <i className={classNames('p', 'q')}>classNames</i>",
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )

    const nodes = loadNodes('pages/Home.jsx', evalOptions())
    expect(nodes.find((n) => n.name === 'a')?.props.className).toBe('a b')
    expect(nodes.find((n) => n.name === 'b')?.props.className).toBe('x y')
    expect(nodes.find((n) => n.name === 'i')?.props.className).toBe('p q')
  })

  it('flattens an array argument and keeps truthy object keys', () => {
    write(
      'pages/Home.jsx',
      [
        'export default function Home() {',
        "  return <div className={cn(['a', 'b'], { c: true, d: false })}>Hi</div>",
        '}',
        '',
      ].join('\n'),
    )

    const div = loadNodes('pages/Home.jsx', evalOptions()).find((n) => n.name === 'div')
    expect(div?.props.className).toBe('a b c')
  })
})
