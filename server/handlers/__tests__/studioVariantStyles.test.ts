/**
 * CV-4 — a style edit made on one variant lands in THAT variant's rule.
 *
 * Each case is a REAL temp project: the binding analyzer reads the component
 * from disk (`extractLocalComponentCatalog`), the variant edit context decides
 * the one rule an edit may land in (`deriveVariantStyleContext`, the function
 * the inspector calls), and the edit goes through `applyStudioEditBatch`, the
 * engine `/save` and the MCP tool share. The assertions are on bytes: the
 * member's rule gains the declaration, EVERY other byte of every file is what
 * it was (the base rule above all), and clearing the declaration puts the file
 * back exactly.
 *
 * One fixture per binding kind the read model claims, and one per way the
 * context must REFUSE — a refusal is asserted as hard as a write. Nothing
 * here is from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject } from '@core/page-parser'
import { deriveVariantStyleContext, type VariantAxisInput, type VariantStyleContext } from '@core/component-variants'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'
import { extractLocalComponentCatalog } from '../studio/componentSpecExtract'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

/** The tag-name position of the first `<needle` in a file: the `line:col` a node id carries. */
function tagAt(rel: string, needle: string): { line: number; column: number } {
  const text = read(rel)
  const offset = text.indexOf(`<${needle}`)
  if (offset < 0) throw new Error(`no <${needle} in ${rel}`)
  const before = text.slice(0, offset + 1)
  return { line: before.split('\n').length, column: offset + 1 - (before.lastIndexOf('\n') + 1) + 1 }
}

/** The context the inspector would derive for `<tag>` inside `component`, with the given call-site values. */
function contextFor(file: string, component: string, tag: string, shown: Record<string, string>, chosenProp?: string): VariantStyleContext | null {
  const specs = extractLocalComponentCatalog(createWorkspaceProject(dir), dir, { onlyFile: file })
  const spec = specs.find((candidate) => candidate.exportName === component)
  if (!spec) throw new Error(`no ${component} in ${file}`)
  const axes: VariantAxisInput[] = spec.props
    .filter((prop) => prop.binding !== undefined)
    .map((prop) => ({ prop: prop.name, member: shown[prop.name] ?? (prop.defaultValue === undefined ? undefined : String(prop.defaultValue)), binding: prop.binding }))
  return deriveVariantStyleContext(tagAt(file, tag), axes, chosenProp)
}

function cssSet(file: string, selector: string, property: string, value: string): StudioEdit {
  return { kind: 'css', op: 'set', nodeId: `css:${file}#${selector}##${property}`, file, selector, property, value }
}

function cssUnset(file: string, selector: string, property: string): StudioEdit {
  return { kind: 'css', op: 'unset', nodeId: `css:${file}#${selector}##${property}`, file, selector, property }
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8')
    }
  }
  walk(dir)
  return out
}

/**
 * The shared proof for a context that names a rule: the edit lands in that
 * rule alone, the files differ from before in exactly that one place, and an
 * unset restores every byte.
 */
function expectEditLandsOnlyIn(
  context: VariantStyleContext | null,
  expected: { selector: string; file: string },
  property: string,
  value: string,
  after: string,
  /** The value the rule held before, when the edit rewrote it; absent when the edit added the declaration. */
  previous?: string,
) {
  expect(context).not.toBeNull()
  const chosen = context!.chosen
  if (chosen.kind !== 'rule') throw new Error(`expected a rule, got a refusal: ${chosen.message}`)
  expect({ selector: chosen.selector, file: chosen.file }).toEqual(expected)

  const before = snapshot()
  const result = applyStudioEditBatch(dir, [cssSet(chosen.file, chosen.selector, property, value)], {}, EDITOR)
  expect(result.refusals).toEqual([])
  expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['rule'])
  const written = snapshot()
  const changed = Object.keys(written).filter((file) => written[file] !== before[file])
  expect(changed).toEqual([chosen.file])
  expect(written[chosen.file]).toBe(after)

  const cleared = applyStudioEditBatch(
    dir,
    [previous === undefined ? cssUnset(chosen.file, chosen.selector, property) : cssSet(chosen.file, chosen.selector, property, previous)],
    {},
    EDITOR,
  )
  expect(cleared.refusals).toEqual([])
  expect(snapshot()).toEqual(before)
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-variant-styles-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a CSS module class map', () => {
  const TAG = [
    "import styles from './Tag.module.css'",
    '',
    "export type Tone = 'calm' | 'loud'",
    '',
    "export function Tag({ tone = 'calm', label }: { tone?: Tone; label: string }) {",
    '  return <span className={`${styles.base} ${styles[tone]}`}>{label}</span>',
    '}',
    '',
  ].join('\n')
  const CSS = ['.base {', '  padding: 4px;', '  color: black;', '}', '', '.calm {', '  background: #eef;', '}', '', '.loud {', '  background: #fee;', '}', ''].join('\n')

  beforeEach(() => {
    write('ui/Tag.tsx', TAG)
    write('ui/Tag.module.css', CSS)
  })

  it('a colour the base rule sets still lands in the loud rule, never in .base', () => {
    const context = contextFor('ui/Tag.tsx', 'Tag', 'span', { tone: 'loud' })
    expect(context?.chosen.kind === 'rule' && context.chosen.label).toBe('Editing tone loud: .loud in Tag.module.css')
    expectEditLandsOnlyIn(
      context,
      { selector: '.loud', file: 'ui/Tag.module.css' },
      'color',
      'navy',
      ['.base {', '  padding: 4px;', '  color: black;', '}', '', '.calm {', '  background: #eef;', '}', '', '.loud {', '  background: #fee;', '  color: navy;', '}', ''].join('\n'),
    )
  })

  it('the member the element is shown with picks the rule: calm edits .calm', () => {
    const context = contextFor('ui/Tag.tsx', 'Tag', 'span', { tone: 'calm' })
    expectEditLandsOnlyIn(
      context,
      { selector: '.calm', file: 'ui/Tag.module.css' },
      'background',
      'white',
      ['.base {', '  padding: 4px;', '  color: black;', '}', '', '.calm {', '  background: white;', '}', '', '.loud {', '  background: #fee;', '}', ''].join('\n'),
      '#eef',
    )
  })

  it('an unset prop is the declared default', () => {
    const context = contextFor('ui/Tag.tsx', 'Tag', 'span', {})
    expect(context?.chosen).toMatchObject({ kind: 'rule', member: 'calm', selector: '.calm' })
  })
})

describe('a data attribute', () => {
  const BADGE = [
    "import './Badge.css'",
    '',
    "export type Kind = 'quiet' | 'bold'",
    '',
    "export function Badge({ kind = 'quiet', text }: { kind?: Kind; text: string }) {",
    '  return (',
    '    <strong className="badge" data-kind={kind}>',
    '      {text}',
    '    </strong>',
    '  )',
    '}',
    '',
  ].join('\n')
  const CSS = [".badge { color: #333; padding: 2px 6px; }", "[data-kind='quiet'] { opacity: 0.7; }", "[data-kind='bold'] { font-weight: 700; }", ''].join('\n')

  beforeEach(() => {
    write('ui/Badge.tsx', BADGE)
    write('ui/Badge.css', CSS)
  })

  it('lands in the attribute rule of the shown value and leaves .badge alone', () => {
    const context = contextFor('ui/Badge.tsx', 'Badge', 'strong', { kind: 'bold' })
    expect(context?.chosen.kind === 'rule' && context.chosen.label).toBe("Editing kind bold: [data-kind='bold'] in Badge.css")
    expectEditLandsOnlyIn(
      context,
      { selector: "[data-kind='bold']", file: 'ui/Badge.css' },
      'color',
      'crimson',
      [".badge { color: #333; padding: 2px 6px; }", "[data-kind='quiet'] { opacity: 0.7; }", "[data-kind='bold'] { font-weight: 700; color: crimson; }", ''].join('\n'),
    )
  })
})

describe('a lookup object of class names', () => {
  const NOTE = [
    "import './Note.css'",
    '',
    "export type Level = 'info' | 'warn'",
    '',
    'const levelClass = {',
    "  info: 'note-info',",
    "  warn: 'note-warn',",
    '}',
    '',
    "export function Note({ level = 'info', children }: { level?: Level; children?: string }) {",
    '  return <aside className={`note ${levelClass[level]}`}>{children}</aside>',
    '}',
    '',
  ].join('\n')
  const CSS = ['.note {', '  border: 1px solid;', '  color: #222;', '}', '', '.note-info {', '  border-color: teal;', '}', '', '.note-warn {', '  border-color: orange;', '}', ''].join('\n')

  beforeEach(() => {
    write('ui/Note.tsx', NOTE)
    write('ui/Note.css', CSS)
  })

  it('lands in the rule behind the entry of the shown value', () => {
    const context = contextFor('ui/Note.tsx', 'Note', 'aside', { level: 'warn' })
    expectEditLandsOnlyIn(
      context,
      { selector: '.note-warn', file: 'ui/Note.css' },
      'color',
      'maroon',
      ['.note {', '  border: 1px solid;', '  color: #222;', '}', '', '.note-info {', '  border-color: teal;', '}', '', '.note-warn {', '  border-color: orange;', '  color: maroon;', '}', ''].join('\n'),
    )
  })
})

describe('a cva variant group', () => {
  const ALERT = [
    "import { cva } from 'class-variance-authority'",
    "import './Alert.css'",
    '',
    "export type Severity = 'low' | 'high'",
    '',
    "const alertStyles = cva('alert', {",
    '  variants: {',
    '    severity: {',
    "      low: 'alert-low',",
    "      high: 'alert-high',",
    '    },',
    '  },',
    '})',
    '',
    "export function Alert({ severity = 'low', body }: { severity?: Severity; body: string }) {",
    '  return <div className={alertStyles({ severity })}>{body}</div>',
    '}',
    '',
  ].join('\n')
  const CSS = ['.alert { padding: 8px; color: #111; }', '.alert-low { background: #efe; }', '.alert-high { background: #fdd; }', ''].join('\n')

  beforeEach(() => {
    write('ui/Alert.tsx', ALERT)
    write('ui/Alert.css', CSS)
  })

  it('lands in the rule behind the cva entry of the shown value', () => {
    const context = contextFor('ui/Alert.tsx', 'Alert', 'div', { severity: 'high' })
    expectEditLandsOnlyIn(
      context,
      { selector: '.alert-high', file: 'ui/Alert.css' },
      'color',
      'darkred',
      ['.alert { padding: 8px; color: #111; }', '.alert-low { background: #efe; }', '.alert-high { background: #fdd; color: darkred; }', ''].join('\n'),
    )
  })
})

describe('the refusals are named, with a remedy, and nothing is written', () => {
  it('a variant styled by utility classes (Tailwind) has no rule: refused by name, base untouched', () => {
    const BUTTON = [
      "import { cva } from 'class-variance-authority'",
      '',
      "export type Look = 'solid' | 'outline'",
      '',
      "const look = cva('inline-flex px-3', {",
      '  variants: {',
      '    look: {',
      "      solid: 'bg-blue-600 text-white',",
      "      outline: 'border border-blue-600',",
      '    },',
      '  },',
      '})',
      '',
      "export function Cta({ look: appearance = 'solid', label }: { look?: Look; label: string }) {",
      '  return <button className={look({ look: appearance })}>{label}</button>',
      '}',
      '',
    ].join('\n')
    write('ui/Cta.tsx', BUTTON)
    const before = snapshot()
    const context = contextFor('ui/Cta.tsx', 'Cta', 'button', { look: 'outline' })
    expect(context?.chosen).toMatchObject({ kind: 'refused', prop: 'look', member: 'outline', reason: 'no-stylesheet-rule' })
    const chosen = context!.chosen
    if (chosen.kind !== 'refused') throw new Error('unreachable')
    expect(chosen.message).toContain('look outline')
    expect(chosen.message).toContain('ui/Cta.tsx:9')
    expect(chosen.remedy).toContain('ui/Cta.tsx:9')
    expect(chosen.openAt).toEqual({ file: 'ui/Cta.tsx', line: 9 })
    expect(snapshot()).toEqual(before)
  })

  it('a variant picked in computed code is opaque: refused naming the line', () => {
    const PILL = [
      "import './Pill.css'",
      '',
      "export type Size = 'sm' | 'lg'",
      '',
      "export function Pill({ size = 'sm', text }: { size?: Size; text: string }) {",
      "  const pad = size === 'lg' ? '12px' : '4px'",
      '  return <span className="pill" style={{ padding: pad }}>{text}</span>',
      '}',
      '',
    ].join('\n')
    write('ui/Pill.tsx', PILL)
    write('ui/Pill.css', '.pill { color: #444; }\n')
    const context = contextFor('ui/Pill.tsx', 'Pill', 'span', { size: 'lg' })
    expect(context?.chosen).toMatchObject({ kind: 'refused', prop: 'size', member: 'lg', reason: 'opaque-binding', openAt: { file: 'ui/Pill.tsx', line: 6 } })
    if (context?.chosen.kind !== 'refused') throw new Error('unreachable')
    expect(context.chosen.message).toContain('size lg')
    expect(context.chosen.message).toContain('ui/Pill.tsx:6')
    expect(context.chosen.remedy).toContain('ui/Pill.tsx:6')
  })

  it('a member with no rule in the stylesheet is refused naming the class it looked for', () => {
    write(
      'ui/Chip.tsx',
      [
        "import './Chip.css'",
        '',
        "export type Mood = 'happy' | 'sad'",
        '',
        "export function Chip({ mood = 'happy', text }: { mood?: Mood; text: string }) {",
        '  return <i className={`chip chip-${mood}`}>{text}</i>',
        '}',
        '',
      ].join('\n'),
    )
    write('ui/Chip.css', '.chip { color: #444; }\n.chip-happy { background: gold; }\n')
    const context = contextFor('ui/Chip.tsx', 'Chip', 'i', { mood: 'sad' })
    expect(context?.chosen).toMatchObject({ kind: 'refused', prop: 'mood', member: 'sad', reason: 'no-rule' })
    if (context?.chosen.kind !== 'refused') throw new Error('unreachable')
    expect(context.chosen.message).toContain('.chip-sad')
    expect(context.chosen.remedy).toContain('.chip-sad')
  })

  it('an element no variant prop styles gets no context (the ordinary rules apply)', () => {
    write(
      'ui/Card.tsx',
      [
        "import styles from './Card.module.css'",
        '',
        "export type Look = 'flat' | 'raised'",
        '',
        "export function Card({ look = 'flat', title }: { look?: Look; title: string }) {",
        '  return (',
        '    <section className={styles[look]}>',
        '      <h3>{title}</h3>',
        '    </section>',
        '  )',
        '}',
        '',
      ].join('\n'),
    )
    write('ui/Card.module.css', '.flat { border: 0; }\n.raised { box-shadow: 0 1px 2px #0003; }\n')
    expect(contextFor('ui/Card.tsx', 'Card', 'section', { look: 'raised' })?.chosen).toMatchObject({ kind: 'rule', selector: '.raised' })
    expect(contextFor('ui/Card.tsx', 'Card', 'h3', { look: 'raised' })).toBeNull()
  })

  it('several props style the element: the first with a rule is chosen, and a pick overrides it', () => {
    write(
      'ui/Key.tsx',
      [
        "import './Key.css'",
        '',
        "export type Tone = 'plain' | 'accent'",
        "export type Scale = 'small' | 'large'",
        '',
        "export function Key({ tone = 'plain', scale = 'small' }: { tone?: Tone; scale?: Scale }) {",
        '  return <kbd className="key" data-tone={tone} data-scale={scale}>K</kbd>',
        '}',
        '',
      ].join('\n'),
    )
    write(
      'ui/Key.css',
      ".key { color: #000; }\n[data-tone='plain'] { background: #eee; }\n[data-tone='accent'] { background: gold; }\n[data-scale='small'] { font-size: 10px; }\n[data-scale='large'] { font-size: 18px; }\n",
    )
    const context = contextFor('ui/Key.tsx', 'Key', 'kbd', { tone: 'accent', scale: 'large' })
    expect(context?.chosen).toMatchObject({ selector: "[data-tone='accent']" })
    expect(context?.axes.map((axis) => axis.kind === 'rule' && axis.selector)).toEqual(["[data-tone='accent']", "[data-scale='large']"])
    expect(contextFor('ui/Key.tsx', 'Key', 'kbd', { tone: 'accent', scale: 'large' }, 'scale')?.chosen).toMatchObject({ selector: "[data-scale='large']" })
  })
})

describe('the undo journal restores a variant style that needed an override rung', () => {
  it('an !important base is beaten inside the variant rule, and one restore puts the file back byte for byte', () => {
    write(
      'ui/Link.tsx',
      [
        "import './Link.css'",
        '',
        "export type Mode = 'quiet' | 'loud'",
        '',
        "export function Link({ mode = 'quiet', to }: { mode?: Mode; to: string }) {",
        '  return <a className={`link link-${mode}`} href={to}>go</a>',
        '}',
        '',
      ].join('\n'),
    )
    const css = '.link { color: gray; }\n.link-quiet { padding: 4px 8px !important; }\n.link-loud { font-weight: 700; }\n'
    write('ui/Link.css', css)
    const context = contextFor('ui/Link.tsx', 'Link', 'a', { mode: 'quiet' })
    if (context?.chosen.kind !== 'rule') throw new Error('expected a rule')
    const result = applyStudioEditBatch(dir, [cssSet(context.chosen.file, context.chosen.selector, 'padding-top', '20px')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['expanded'])
    expect(read('ui/Link.css')).toBe('.link { color: gray; }\n.link-quiet { padding: 20px 8px 4px !important; }\n.link-loud { font-weight: 700; }\n')
    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('ui/Link.css')).toBe(css)
  })
})
