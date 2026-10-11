/**
 * componentVariantBindings — the variant binding analyzer, one fixture per
 * pattern it claims and one per way it must REFUSE to claim.
 *
 * The fixtures are generic, hand-written components (`Tag`, `Chip`, `Panel`,
 * `Switch`…) that share nothing with the eSIM corpus, per
 * `genericRepoShapes.test.ts`'s discipline: a suite grown from one repo's
 * habits encodes that repo's habits. Files are real, on a temp workspace, so
 * the stylesheet reads go through the same contained reader production uses.
 *
 * The refusals matter as much as the claims: an analyzer that starts
 * "recognising" a ternary chain is the regression that lets a later Add
 * variant write a rule nothing consumes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Node } from 'ts-morph'
import {
  analyzeVariantBinding,
  createComponentAnalysisContext,
  createWorkspaceProject,
  readPropDefault,
  type AnalyzedProp,
} from '@core/page-parser'

let root: string
let workspace: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-bindings-'))
  workspace = path.join(root, 'ws')
  fs.mkdirSync(workspace)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(workspace, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function declarationOf(file: string, name: string): Node {
  const project = createWorkspaceProject(workspace)
  const sourceFile = project.getSourceFileOrThrow(path.join(workspace, ...file.split('/')))
  const found = sourceFile.getFunction(name) ?? sourceFile.getVariableDeclaration(name)
  if (!found) throw new Error(`no component ${name} in ${file}`)
  return found
}

function analyze(file: string, component: string, prop: AnalyzedProp) {
  const ctx = createComponentAnalysisContext(declarationOf(file, component), workspace)
  if (!ctx) throw new Error('component not readable')
  return analyzeVariantBinding(ctx, prop)
}

const TONE: AnalyzedProp = { name: 'tone', kind: 'enum', members: ['info', 'warn', 'danger'] }

describe('css-module-class', () => {
  it('claims `styles[prop]` and locates the rule of every member that has one', () => {
    write(
      'src/Tag.tsx',
      [
        "import styles from './Tag.module.css'",
        "type Tone = 'info' | 'warn' | 'danger'",
        "export function Tag({ tone = 'info' }: { tone?: Tone }) {",
        '  return <span className={styles[tone]}>tag</span>',
        '}',
      ].join('\n'),
    )
    write('src/Tag.module.css', ['.info {', '  color: blue;', '}', '', '.warn {', '  color: orange;', '}'].join('\n'))

    const binding = analyze('src/Tag.tsx', 'Tag', TONE)
    expect(binding.kind).toBe('css-module-class')
    if (binding.kind !== 'css-module-class') return
    expect(binding.scope).toBe('module')
    expect(binding.expr).toBe('styles[tone]')
    // `danger` has no rule: reported as absent, not invented.
    expect(binding.rules.map((r) => r.member)).toEqual(['info', 'warn'])
    expect(binding.rules[0]).toMatchObject({ selector: '.info', range: { file: 'src/Tag.module.css', line: 1, endLine: 3 } })
    expect(binding.rules[1]!.range.line).toBe(5)
  })

  it('claims a prefixed module key (template literal) and matches `.tone-<member>`', () => {
    write(
      'src/Tag.tsx',
      [
        "import styles from './Tag.module.css'",
        "export function Tag({ tone }: { tone: 'info' | 'warn' | 'danger' }) {",
        '  return <span className={styles[`tone-${tone}`]}>tag</span>',
        '}',
      ].join('\n'),
    )
    write('src/Tag.module.css', '.tone-danger { color: red; }\n.tone-info { color: blue; }\n')

    const binding = analyze('src/Tag.tsx', 'Tag', TONE)
    expect(binding.kind).toBe('css-module-class')
    if (binding.kind !== 'css-module-class') return
    expect(binding.rules.map((r) => [r.member, r.selector])).toEqual([
      ['info', '.tone-info'],
      ['danger', '.tone-danger'],
    ])
  })

  it('claims a class-string template against a plain stylesheet (scope: global)', () => {
    write(
      'src/Chip.tsx',
      [
        "import './Chip.css'",
        "export function Chip({ size }: { size: 'sm' | 'lg' }) {",
        '  return <span className={`chip chip--${size} wide`}>x</span>',
        '}',
      ].join('\n'),
    )
    write('src/Chip.css', '.chip { display: inline-block; }\n.chip--sm { padding: 2px; }\n.chip--lg { padding: 8px; }\n')

    const binding = analyze('src/Chip.tsx', 'Chip', { name: 'size', kind: 'enum', members: ['sm', 'lg'] })
    expect(binding.kind).toBe('css-module-class')
    if (binding.kind !== 'css-module-class') return
    expect(binding.scope).toBe('global')
    expect(binding.rules.map((r) => r.selector)).toEqual(['.chip--sm', '.chip--lg'])
  })

  it('does not take a state rule (`.info:hover`) for the member base rule', () => {
    write(
      'src/Tag.tsx',
      "import styles from './Tag.module.css'\nexport function Tag({ tone }: { tone: 'info' | 'warn' }) { return <i className={styles[tone]} /> }\n",
    )
    write('src/Tag.module.css', '.info:hover { color: blue; }\n')
    const binding = analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] })
    expect(binding.kind).toBe('opaque')
  })
})

describe('data-attr', () => {
  it('claims `data-x={prop}` and finds the `[data-x="member"]` rules in an imported stylesheet', () => {
    write(
      'src/Panel.tsx',
      [
        "import './Panel.css'",
        "export function Panel({ density }: { density: 'compact' | 'roomy' }) {",
        '  return <div data-density={density}>panel</div>',
        '}',
      ].join('\n'),
    )
    write('src/Panel.css', '[data-density="compact"] { padding: 4px; }\n[data-density=roomy] { padding: 16px; }\n')

    const binding = analyze('src/Panel.tsx', 'Panel', { name: 'density', kind: 'enum', members: ['compact', 'roomy'] })
    expect(binding.kind).toBe('data-attr')
    if (binding.kind !== 'data-attr') return
    expect(binding.attr).toBe('data-density')
    expect(binding.rules.map((r) => r.member)).toEqual(['compact', 'roomy'])
    expect(binding.range.line).toBe(3)
  })

  it('claims a boolean through `data-x` when the stylesheet selects `[data-x]`', () => {
    write(
      'src/Switch.tsx',
      "import './Switch.css'\nexport function Switch({ checked }: { checked: boolean }) { return <button data-checked={checked} /> }\n",
    )
    write('src/Switch.css', '[data-checked] { background: green; }\n')
    const binding = analyze('src/Switch.tsx', 'Switch', { name: 'checked', kind: 'boolean', members: ['true'] })
    expect(binding.kind).toBe('data-attr')
  })
})

describe('lookup-object', () => {
  it('claims `lookup[prop]` over a same-file object and records each entry range', () => {
    write(
      'src/Banner.tsx',
      [
        "type Tone = 'info' | 'warn' | 'danger'",
        'const toneClass: Record<Tone, string> = {',
        "  info: 'bg-blue-100',",
        "  warn: 'bg-amber-100',",
        '}',
        'export function Banner({ tone }: { tone: Tone }) {',
        '  return <div className={toneClass[tone]}>b</div>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Banner.tsx', 'Banner', TONE)
    expect(binding.kind).toBe('lookup-object')
    if (binding.kind !== 'lookup-object') return
    expect(binding.objectName).toBe('toneClass')
    expect(binding.entries.map((e) => [e.member, e.range.line])).toEqual([
      ['info', 3],
      ['warn', 4],
    ])
  })

  it('refuses a lookup object that is imported (not readable in this file)', () => {
    write(
      'src/Banner.tsx',
      "import { toneClass } from './tones'\nexport function Banner({ tone }: { tone: 'info' | 'warn' }) { return <div className={toneClass[tone]} /> }\n",
    )
    expect(analyze('src/Banner.tsx', 'Banner', { name: 'tone', kind: 'enum', members: ['info', 'warn'] }).kind).toBe('opaque')
  })
})

describe('cva', () => {
  const GROUP: AnalyzedProp = { name: 'intent', kind: 'enum', members: ['solid', 'outline'] }

  it('claims a prop passed to a same-file cva() config imported from class-variance-authority', () => {
    write(
      'src/Action.tsx',
      [
        // Assembled so the no-tailwind-deps text scan does not mistake this fixture for an import in our own source.
        "import { cva } from '" + 'class-variance-authority' + "'",
        "const actionVariants = cva('action', {",
        '  variants: {',
        '    intent: {',
        "      solid: 'bg-black text-white',",
        "      outline: 'border',",
        '    },',
        '  },',
        '})',
        "export function Action({ intent }: { intent: 'solid' | 'outline' }) {",
        '  return <button className={actionVariants({ intent })}>go</button>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Action.tsx', 'Action', GROUP)
    expect(binding.kind).toBe('cva')
    if (binding.kind !== 'cva') return
    expect(binding.callee).toBe('cva')
    expect(binding.group).toBe('intent')
    expect(binding.entries.map((e) => [e.member, e.range.line])).toEqual([
      ['solid', 5],
      ['outline', 6],
    ])
  })

  it('follows a renamed prop (`intent: kind`) and an aliased tv import', () => {
    write(
      'src/Action.tsx',
      [
        "import { tv as makeVariants } from 'tailwind-variants'",
        'const style = makeVariants({',
        "  base: 'a',",
        "  variants: { intent: { solid: 'x', outline: 'y' } },",
        '})',
        "export function Action({ intent: kind }: { intent: 'solid' | 'outline' }) {",
        '  return <button className={style({ intent: kind })}>go</button>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Action.tsx', 'Action', GROUP)
    expect(binding.kind).toBe('cva')
    if (binding.kind !== 'cva') return
    expect(binding.callee).toBe('tv')
  })

  it('does not trust a function that is merely NAMED cva (not imported from the library)', () => {
    write(
      'src/Action.tsx',
      [
        'function cva(base: string, config: object) { return (_a: object) => base }',
        "const actionVariants = cva('action', { variants: { intent: { solid: 'x', outline: 'y' } } })",
        "export function Action({ intent }: { intent: 'solid' | 'outline' }) {",
        '  return <button className={actionVariants({ intent })}>go</button>',
        '}',
      ].join('\n'),
    )
    expect(analyze('src/Action.tsx', 'Action', GROUP).kind).toBe('opaque')
  })
})

describe('boolean-class', () => {
  it('claims `cn(base, flag && "class")` and ignores pass-through uses of the same prop', () => {
    write(
      'src/Field.tsx',
      [
        "import { cn } from './cn'",
        'export function Field({ disabled }: { disabled?: boolean }) {',
        "  return <input disabled={disabled} className={cn('field', disabled && 'is-disabled')} />",
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Field.tsx', 'Field', { name: 'disabled', kind: 'boolean', members: ['true'] })
    expect(binding.kind).toBe('boolean-class')
    if (binding.kind !== 'boolean-class') return
    expect(binding.className).toBe('is-disabled')
    expect(binding.range).toMatchObject({ file: 'src/Field.tsx', line: 3 })
  })

  it('claims a ternary with an empty else inside className', () => {
    write(
      'src/Field.tsx',
      "export function Field({ busy }: { busy?: boolean }) { return <i className={busy ? 'is-busy' : ''} /> }\n",
    )
    expect(analyze('src/Field.tsx', 'Field', { name: 'busy', kind: 'boolean', members: ['true'] }).kind).toBe('boolean-class')
  })

  it('refuses a `flag && "text"` that is not building a class string', () => {
    write(
      'src/Field.tsx',
      "export function Field({ busy }: { busy?: boolean }) { const label = busy && 'Loading'; return <i>{label}</i> }\n",
    )
    expect(analyze('src/Field.tsx', 'Field', { name: 'busy', kind: 'boolean', members: ['true'] }).kind).toBe('opaque')
  })
})

describe('opaque', () => {
  it('names the line of a computed read (ternary chain)', () => {
    write(
      'src/Badge.tsx',
      [
        "export function Badge({ tone }: { tone: 'info' | 'warn' }) {",
        '  return (',
        "    <span className={tone === 'warn' ? 'bg-amber' : 'bg-blue'}>b</span>",
        '  )',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Badge.tsx', 'Badge', { name: 'tone', kind: 'enum', members: ['info', 'warn'] })
    expect(binding).toMatchObject({ kind: 'opaque', file: 'src/Badge.tsx', line: 3 })
  })

  it('is opaque when a claimable use is ALSO read by computed code', () => {
    write(
      'src/Tag.tsx',
      [
        "import styles from './Tag.module.css'",
        "export function Tag({ tone }: { tone: 'info' | 'warn' }) {",
        "  const loud = tone === 'warn'",
        '  return <span className={styles[tone]}>{loud ? "!" : ""}</span>',
        '}',
      ].join('\n'),
    )
    write('src/Tag.module.css', '.info { color: blue; }\n.warn { color: red; }\n')
    expect(analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] })).toMatchObject({
      kind: 'opaque',
      line: 3,
    })
  })

  it('is opaque when one prop is consumed in two different ways', () => {
    write(
      'src/Tag.tsx',
      [
        "import styles from './Tag.module.css'",
        "export function Tag({ tone }: { tone: 'info' | 'warn' }) {",
        '  return <span data-tone={tone} className={styles[tone]}>x</span>',
        '}',
      ].join('\n'),
    )
    write('src/Tag.module.css', '.info { color: blue; }\n.warn { color: red; }\n[data-tone="warn"] { color: red; }\n')
    const binding = analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] })
    expect(binding.kind).toBe('opaque')
    if (binding.kind === 'opaque') expect(binding.reason).toContain('more than one way')
  })

  it('is opaque when the expression matches but the stylesheet is not on disk', () => {
    write(
      'src/Tag.tsx',
      "import styles from './Gone.module.css'\nexport function Tag({ tone }: { tone: 'info' | 'warn' }) { return <i className={styles[tone]} /> }\n",
    )
    const binding = analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] })
    expect(binding.kind).toBe('opaque')
    if (binding.kind === 'opaque') expect(binding.reason).toContain('nothing it points at was found')
  })

  it('never reads a stylesheet outside the workspace root', () => {
    fs.writeFileSync(path.join(root, 'outside.module.css'), '.info { color: blue; }\n.warn { color: red; }\n')
    write(
      'src/Tag.tsx',
      "import styles from '../../outside.module.css'\nexport function Tag({ tone }: { tone: 'info' | 'warn' }) { return <i className={styles[tone]} /> }\n",
    )
    expect(analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] }).kind).toBe('opaque')
  })

  it('says so when the prop is never read', () => {
    write('src/Tag.tsx', "export function Tag({ tone }: { tone: 'info' | 'warn' }) { return <i /> }\n")
    const binding = analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] })
    expect(binding.kind).toBe('opaque')
    if (binding.kind === 'opaque') expect(binding.reason).toContain('never read')
  })
})

describe('how the prop is named', () => {
  it('reads `props.tone` from an undestructured props parameter', () => {
    write(
      'src/Tag.tsx',
      [
        "import styles from './Tag.module.css'",
        "export function Tag(props: { tone: 'info' | 'warn' }) {",
        '  return <i className={styles[props.tone]} />',
        '}',
      ].join('\n'),
    )
    write('src/Tag.module.css', '.info { color: blue; }\n')
    expect(analyze('src/Tag.tsx', 'Tag', { name: 'tone', kind: 'enum', members: ['info', 'warn'] }).kind).toBe('css-module-class')
  })

  it('reads a literal destructuring default, including a renamed binding', () => {
    write(
      'src/Tag.tsx',
      "export const Tag = ({ tone: t = 'warn', count = 3, on = false }: { tone?: string; count?: number; on?: boolean }) => <i>{t}{count}{String(on)}</i>\n",
    )
    const declaration = declarationOf('src/Tag.tsx', 'Tag')
    expect(readPropDefault(declaration, 'tone')).toBe('warn')
    expect(readPropDefault(declaration, 'count')).toBe(3)
    expect(readPropDefault(declaration, 'on')).toBe(false)
    expect(readPropDefault(declaration, 'missing')).toBeUndefined()
  })

  it('has no default when the initializer is computed', () => {
    write('src/Tag.tsx', "const FALLBACK = 'info'\nexport function Tag({ tone = FALLBACK }: { tone?: string }) { return <i>{tone}</i> }\n")
    expect(readPropDefault(declarationOf('src/Tag.tsx', 'Tag'), 'tone')).toBeUndefined()
  })
})

describe('the element a binding styles, and the rule behind an entry (CV-4)', () => {
  it('reports the tag-name position of the element that consumes the prop', () => {
    write(
      'src/Tag.tsx',
      [
        "import styles from './Tag.module.css'",
        "type Tone = 'info' | 'warn' | 'danger'",
        "export function Tag({ tone = 'info' }: { tone?: Tone }) {",
        '  return (',
        '    <div>',
        '      <span className={styles[tone]}>tag</span>',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    )
    write('src/Tag.module.css', ['.info {', '  color: blue;', '}'].join('\n'))
    const binding = analyze('src/Tag.tsx', 'Tag', TONE)
    // the `span`, not the wrapper: line 6, column of `span` after `<`
    expect(binding.kind === 'css-module-class' && binding.element).toEqual({ line: 6, column: 8 })
  })

  it('a computed use names its element too, so a refusal can be attributed to the right node', () => {
    write(
      'src/Tag.tsx',
      [
        "type Tone = 'info' | 'warn' | 'danger'",
        "export function Tag({ tone = 'info' }: { tone?: Tone }) {",
        '  return <b style={{ color: tone === "warn" ? "orange" : "blue" }}>tag</b>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Tag.tsx', 'Tag', TONE)
    expect(binding.kind).toBe('opaque')
    expect(binding.kind === 'opaque' && binding.element).toEqual({ line: 3, column: 11 })
  })

  it('a class string built above the return styles the first element', () => {
    write('src/Tag.css', '.t-info { color: blue; }\n')
    write(
      'src/Tag.tsx',
      [
        "import './Tag.css'",
        "const byTone = { info: 't-info', warn: 't-warn', danger: 't-danger' }",
        "type Tone = 'info' | 'warn' | 'danger'",
        "export function Tag({ tone = 'info' }: { tone?: Tone }) {",
        '  const cls = byTone[tone]',
        '  return <span className={cls}>tag</span>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Tag.tsx', 'Tag', TONE)
    expect(binding.kind === 'lookup-object' && binding.element).toEqual({ line: 6, column: 11 })
  })

  it('a lookup entry carries the stylesheet rule behind its class when exactly one class has one', () => {
    write('src/Note.css', ['.note { color: #222; }', '.note-info { color: teal; }', '.note-warn { color: orange; }'].join('\n'))
    write(
      'src/Note.tsx',
      [
        "import './Note.css'",
        "const levelClass = { info: 'note note-info', warn: 'note note-warn' }",
        "type Level = 'info' | 'warn'",
        "export function Note({ level = 'info' }: { level?: Level }) {",
        '  return <aside className={levelClass[level]}>n</aside>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Note.tsx', 'Note', { name: 'level', kind: 'enum', members: ['info', 'warn'] })
    expect(binding.kind).toBe('lookup-object')
    if (binding.kind !== 'lookup-object') return
    // `note` is in every entry, so it is the component's base and not the member's
    expect(binding.entries.map((entry) => [entry.member, entry.rule?.selector])).toEqual([
      ['info', '.note-info'],
      ['warn', '.note-warn'],
    ])
  })

  it('an entry of utility classes, or one with two candidate rules, has no rule', () => {
    write('src/Chip.css', ['.a { color: red; }', '.b { color: blue; }', '.c { color: green; }'].join('\n'))
    write(
      'src/Chip.tsx',
      [
        "import './Chip.css'",
        "const byKind = { x: 'a b', y: 'px-2 text-sm', z: 'c' }",
        "type Kind = 'x' | 'y' | 'z'",
        "export function Chip({ kind = 'x' }: { kind?: Kind }) {",
        '  return <i className={byKind[kind]}>c</i>',
        '}',
      ].join('\n'),
    )
    const binding = analyze('src/Chip.tsx', 'Chip', { name: 'kind', kind: 'enum', members: ['x', 'y', 'z'] })
    expect(binding.kind).toBe('lookup-object')
    if (binding.kind !== 'lookup-object') return
    expect(binding.entries.map((entry) => [entry.member, entry.rule?.selector])).toEqual([
      ['x', undefined],
      ['y', undefined],
      ['z', '.c'],
    ])
  })
})
