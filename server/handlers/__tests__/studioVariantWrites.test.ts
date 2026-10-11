/**
 * Add variant / Remove variant / Add property on the wire (CV-3): a real temp
 * project, a real `applyStudioEditBatch`, the bytes on disk.
 *
 * Every fixture is a hand-written component that shares nothing with the eSIM
 * corpus (`Chip`, `Badge`, `Toggle`, `Panel`…), one per styling pattern the
 * variant read model claims, and one per way the write must REFUSE. A refusal
 * is asserted as hard as a write: the files must be byte-identical afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

/** `rel:line:col` of the first occurrence of `needle` — the position the catalog reports for a component's name. */
function idOf(rel: string, needle: string): string {
  const text = read(rel)
  const offset = text.indexOf(needle)
  if (offset < 0) throw new Error(`no ${needle} in ${rel}`)
  const before = text.slice(0, offset)
  return `${rel}:${before.split('\n').length}:${offset - (before.lastIndexOf('\n') + 1) + 1}`
}

const CHIP = [
  "import styles from './Chip.module.css'",
  '',
  "export type Tone = 'info' | 'warn'",
  '',
  "export function Chip({ tone = 'info', label }: { tone?: Tone; label: string }) {",
  '  return <span className={styles[tone]}>{label}</span>',
  '}',
  '',
].join('\n')
const CHIP_CSS = ['.info {', '  color: blue;', '  background: #eef;', '}', '', '.warn {', '  color: orange;', '}', ''].join('\n')
const HOME = [
  "import { Chip } from '../components/Chip'",
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <Chip tone="info" label="One" />',
  '      <Chip tone="warn" label="Two" />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

function batch(edit: StudioEdit) {
  return applyStudioEditBatch(dir, [edit], {}, EDITOR)
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

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-variant-writes-')))
  write('components/Chip.tsx', CHIP)
  write('components/Chip.module.css', CHIP_CSS)
  write('pages/Home.tsx', HOME)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const addDanger = (): StudioEdit => ({ kind: 'add-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'danger' })

describe('add-variant — a CSS module class map', () => {
  it('adds the union member and a copy of the default value\'s rule; one restore puts both files back', () => {
    const result = batch(addDanger())
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('components/Chip.tsx')).toBe(CHIP.replace("'info' | 'warn'", "'info' | 'warn' | 'danger'"))
    expect(read('components/Chip.module.css')).toBe(
      ['.info {', '  color: blue;', '  background: #eef;', '}', '', '.danger {', '  color: blue;', '  background: #eef;', '}', '', '.warn {', '  color: orange;', '}', ''].join('\n'),
    )
    // The call sites are untouched: nothing was written at any of them.
    expect(read('pages/Home.tsx')).toBe(HOME)
    expect(result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')).sort()).toEqual(['components/Chip.module.css', 'components/Chip.tsx'])
    expect(result.shifted).toBe(true)
    expect(result.sharedComponents).toBe(true)

    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/Chip.tsx')).toBe(CHIP)
    expect(read('components/Chip.module.css')).toBe(CHIP_CSS)
  })

  it('keeps a CRLF checkout CRLF in both files', () => {
    write('components/Chip.tsx', CHIP.replace(/\n/g, '\r\n'))
    write('components/Chip.module.css', CHIP_CSS.replace(/\n/g, '\r\n'))
    const result = batch(addDanger())
    expect(result.refusals).toEqual([])
    for (const rel of ['components/Chip.tsx', 'components/Chip.module.css']) {
      const text = read(rel)
      expect(text.replace(/\r\n/g, '')).not.toContain('\n')
      expect(text).toContain('danger')
    }
  })

  it('reuses a rule that already exists for the new name instead of writing a second one', () => {
    write('components/Chip.module.css', `${CHIP_CSS}\n.danger {\n  color: red;\n}\n`)
    const before = read('components/Chip.module.css')
    const result = batch(addDanger())
    expect(result.refusals).toEqual([])
    expect(read('components/Chip.module.css')).toBe(before)
    expect(read('components/Chip.tsx')).toContain("'info' | 'warn' | 'danger'")
  })

  it('adds a module-prefixed class (styles[`btn-${tone}`]) with the same prefix', () => {
    write('components/Chip.tsx', CHIP.replace('styles[tone]', 'styles[`chip-${tone}`]'))
    write('components/Chip.module.css', CHIP_CSS.replace('.info', '.chip-info').replace('.warn', '.chip-warn'))
    const result = batch(addDanger())
    expect(result.refusals).toEqual([])
    expect(read('components/Chip.module.css')).toContain('.chip-danger {\n  color: blue;')
  })
})

describe('add-variant — a data attribute', () => {
  it('copies the default value\'s [data-tone] rule from a global sheet', () => {
    write(
      'components/Badge.tsx',
      [
        "import './Badge.css'",
        "type Tone = 'solid' | 'soft'",
        "export function Badge({ tone = 'solid' }: { tone?: Tone }) {",
        '  return <b data-tone={tone}>badge</b>',
        '}',
        '',
      ].join('\n'),
    )
    write('components/Badge.css', ['b[data-tone="solid"] {', '  color: white;', '}', '', 'b[data-tone="soft"] {', '  color: gray;', '}', ''].join('\n'))
    const result = batch({ kind: 'add-variant', nodeId: idOf('components/Badge.tsx', 'Badge('), exportName: 'Badge', prop: 'tone', name: 'outline' })
    expect(result.refusals).toEqual([])
    expect(read('components/Badge.tsx')).toContain("'solid' | 'soft' | 'outline'")
    expect(read('components/Badge.css')).toContain('b[data-tone="solid"] {\n  color: white;\n}\n\nb[data-tone="outline"] {\n  color: white;\n}\n\nb[data-tone="soft"]')
  })
})

describe('add-variant — a lookup object and a cva', () => {
  it('copies an entry of a same-file lookup object, in its own layout, and extends the type', () => {
    write(
      'components/Panel.tsx',
      [
        "type Size = 'sm' | 'md'",
        'const sizeClass: Record<Size, string> = {',
        "  sm: 'p-1 text-sm',",
        "  md: 'p-3',",
        '}',
        "export function Panel({ size = 'md' }: { size?: Size }) {",
        '  return <section className={sizeClass[size]}>panel</section>',
        '}',
        '',
      ].join('\n'),
    )
    const result = batch({ kind: 'add-variant', nodeId: idOf('components/Panel.tsx', 'Panel('), exportName: 'Panel', prop: 'size', name: 'lg' })
    expect(result.refusals).toEqual([])
    expect(read('components/Panel.tsx')).toBe(
      [
        "type Size = 'sm' | 'md' | 'lg'",
        'const sizeClass: Record<Size, string> = {',
        "  sm: 'p-1 text-sm',",
        "  md: 'p-3',",
        "  lg: 'p-3',",
        '}',
        "export function Panel({ size = 'md' }: { size?: Size }) {",
        '  return <section className={sizeClass[size]}>panel</section>',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('copies a cva group entry', () => {
    write(
      'components/Action.tsx',
      [
        "import { cva } from 'class-variance-authority'",
        "type Kind = 'primary' | 'ghost'",
        "const action = cva('base', {",
        '  variants: {',
        '    kind: {',
        "      primary: 'bg-blue-500',",
        "      ghost: 'bg-transparent',",
        '    },',
        '  },',
        '})',
        "export function Action({ kind = 'primary' }: { kind?: Kind }) {",
        '  return <button className={action({ kind })}>go</button>',
        '}',
        '',
      ].join('\n'),
    )
    const result = batch({ kind: 'add-variant', nodeId: idOf('components/Action.tsx', 'Action('), exportName: 'Action', prop: 'kind', name: 'danger' })
    expect(result.refusals).toEqual([])
    const text = read('components/Action.tsx')
    expect(text).toContain("type Kind = 'primary' | 'ghost' | 'danger'")
    expect(text).toContain("      primary: 'bg-blue-500',\n      danger: 'bg-blue-500',\n      ghost: 'bg-transparent',")
  })
})

describe('add-variant — refusals leave every file byte-identical', () => {
  it('refuses a prop styled in computed code (opaque), naming the line', () => {
    write(
      'components/Flag.tsx',
      [
        "type Level = 'low' | 'high'",
        "export function Flag({ level = 'low' }: { level?: Level }) {",
        "  return <i className={level === 'high' ? 'loud' : 'quiet'}>flag</i>",
        '}',
        '',
      ].join('\n'),
    )
    const before = snapshot()
    const result = batch({ kind: 'add-variant', nodeId: idOf('components/Flag.tsx', 'Flag('), exportName: 'Flag', prop: 'level', name: 'mid' })
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['opaque-binding'])
    expect(result.refusals[0]!.message).toContain('components/Flag.tsx:3')
    expect(snapshot()).toEqual(before)
  })

  it('refuses a union that another file also uses (a shared alias is N targets)', () => {
    write('components/Chip.tsx', CHIP.replace("export type Tone = 'info' | 'warn'", "import type { Tone } from '../types'"))
    write('types.ts', "export type Tone = 'info' | 'warn'\n")
    write('components/Note.tsx', "import type { Tone } from '../types'\nexport function Note({ tone }: { tone?: Tone }) {\n  return <p>{tone}</p>\n}\n")
    const before = snapshot()
    const result = batch(addDanger())
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['shared-union'])
    expect(result.refusals[0]!.message).toContain('components/Note.tsx')
    expect(snapshot()).toEqual(before)
  })

  it('refuses a name that is already a value, an unusable name, a prop that is not an enum, and a missing component', () => {
    const before = snapshot()
    const id = idOf('components/Chip.tsx', 'Chip(')
    for (const [edit, reason] of [
      [{ kind: 'add-variant', nodeId: id, exportName: 'Chip', prop: 'tone', name: 'warn' }, 'variant-exists'],
      [{ kind: 'add-variant', nodeId: id, exportName: 'Chip', prop: 'label', name: 'x' }, 'not-a-variant-prop'],
      [{ kind: 'add-variant', nodeId: id, exportName: 'Ghost', prop: 'tone', name: 'danger' }, 'component-not-found'],
    ] as const) {
      const result = batch(edit)
      expect(result.written).toBe(0)
      expect(result.refusals.map((refusal) => refusal.reason)).toEqual([reason])
    }
    expect(snapshot()).toEqual(before)
  })

  it('refuses a stylesheet reached through a link that lands outside the project, writing neither it nor the union', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-variant-link-'))
    try {
      fs.writeFileSync(path.join(outside, 'Chip.css'), '.btn-info { color: blue; }\n.btn-warn { color: orange; }\n')
      // A junction (a directory link needing no privilege on Windows) inside the project that leads out of it.
      fs.symlinkSync(outside, abs('components/styles'), 'junction')
      write('components/Chip.tsx', CHIP.replace("import styles from './Chip.module.css'", "import './styles/Chip.css'").replace('styles[tone]', '`btn btn-${tone}`'))
      const before = read('components/Chip.tsx')
      const result = batch(addDanger())
      expect(result.written).toBe(0)
      expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['file-unreadable'])
      expect(read('components/Chip.tsx')).toBe(before)
      expect(fs.readFileSync(path.join(outside, 'Chip.css'), 'utf8')).toBe('.btn-info { color: blue; }\n.btn-warn { color: orange; }\n')
    } finally {
      fs.rmSync(abs('components/styles'), { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never writes outside the project: a node id with .. or an absolute path decodes to nothing', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-variant-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'Evil.tsx'), CHIP)
      for (const nodeId of ['../' + path.basename(outside) + '/Evil.tsx:5:17', path.join(outside, 'Evil.tsx') + ':5:17', 'components/../../Evil.tsx:5:17']) {
        const result = batch({ kind: 'add-variant', nodeId, exportName: 'Chip', prop: 'tone', name: 'danger' })
        expect(result.written).toBe(0)
      }
      expect(fs.readFileSync(path.join(outside, 'Evil.tsx'), 'utf8')).toBe(CHIP)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('remove-variant', () => {
  it('removes the union member and its rule when no call site passes it, and one restore brings both back', () => {
    const edit: StudioEdit = { kind: 'remove-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'warn' }
    // Home passes tone="warn" — make it not.
    write('pages/Home.tsx', HOME.replace('tone="warn"', 'tone="info"'))
    const result = batch(edit)
    expect(result.refusals).toEqual([])
    expect(read('components/Chip.tsx')).toBe(CHIP.replace("'info' | 'warn'", "'info'").replace("{ tone?: Tone; label", "{ tone?: Tone; label"))
    expect(read('components/Chip.module.css')).toBe(['.info {', '  color: blue;', '  background: #eef;', '}', ''].join('\n'))
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/Chip.tsx')).toBe(CHIP)
    expect(read('components/Chip.module.css')).toBe(CHIP_CSS)
  })

  it('refuses while a call site passes the value, listing the sites, and writes nothing', () => {
    const before = snapshot()
    const result = batch({ kind: 'remove-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'warn' })
    expect(result.written).toBe(0)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['variant-in-use'])
    expect(result.refusals[0]!.message).toContain('pages/Home.tsx:6')
    expect(snapshot()).toEqual(before)
  })

  it('counts a value passed inside an expression as a use', () => {
    write('pages/Home.tsx', HOME.replace('tone="warn"', "tone={on ? 'warn' : 'info'}"))
    const result = batch({ kind: 'remove-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'warn' })
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['variant-in-use'])
  })

  it('refuses the default value', () => {
    write('pages/Home.tsx', HOME.replace('tone="info"', 'tone="warn"'))
    const result = batch({ kind: 'remove-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'info' })
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['default-variant'])
  })

  describe('a story that passes the value in its args is a call site (CV-3 leftover)', () => {
    const removeWarn = (): StudioEdit => ({ kind: 'remove-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'warn' })

    beforeEach(() => {
      // No page passes "warn" any more: only a story does.
      write('pages/Home.tsx', HOME.replace('tone="warn"', 'tone="info"'))
    })

    it('refuses, naming the story, and writes nothing', () => {
      write(
        'components/Chip.stories.tsx',
        [
          "import { Chip } from './Chip'",
          '',
          'export default { title: "Chip", component: Chip, args: { label: "Hi" } }',
          '',
          'export const Calm = { args: { tone: "info" } }',
          'export const Careful = { args: { tone: "warn" } }',
          '',
        ].join('\n'),
      )
      const before = snapshot()
      const result = batch(removeWarn())
      expect(result.written).toBe(0)
      expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['variant-in-use'])
      expect(result.refusals[0]!.message).toContain('components/Chip.stories.tsx:6')
      expect(result.refusals[0]!.message).not.toContain('components/Chip.stories.tsx:5')
      expect(snapshot()).toEqual(before)
    })

    it('a value set on the meta args reaches every story, so it is a use too', () => {
      write(
        'components/Chip.stories.tsx',
        ["import { Chip } from './Chip'", '', 'export default { component: Chip, args: { tone: "warn", label: "Hi" } }', '', 'export const Only = {}', ''].join('\n'),
      )
      expect(batch(removeWarn()).refusals.map((refusal) => refusal.reason)).toEqual(['variant-in-use'])
    })

    it('a story of a different component, or one that passes another value, is not', () => {
      write('components/Other.tsx', "export function Other({ tone }: { tone?: string }) { return <i>{tone}</i> }\n")
      write(
        'components/Other.stories.tsx',
        ["import { Other } from './Other'", '', 'export default { component: Other }', '', 'export const W = { args: { tone: "warn" } }', ''].join('\n'),
      )
      write(
        'components/Chip.stories.tsx',
        ["import { Chip } from './Chip'", '', 'export default { component: Chip, args: { label: "Hi" } }', '', 'export const Calm = { args: { tone: "info" } }', ''].join('\n'),
      )
      const result = batch(removeWarn())
      expect(result.refusals).toEqual([])
      expect(result.written).toBe(1)
    })
  })
})

describe('state rules travel with the variant (CV-3 leftover)', () => {
  const STATEFUL_CSS = [
    '.info {',
    '  color: blue;',
    '}',
    '',
    '.info:hover {',
    '  color: navy;',
    '}',
    '',
    '.warn {',
    '  color: orange;',
    '}',
    '',
    '.warn:hover,',
    '.warn:focus-visible {',
    '  color: darkorange;',
    '}',
    '',
  ].join('\n')

  beforeEach(() => {
    write('components/Chip.module.css', STATEFUL_CSS)
  })

  it('Add variant copies the default value\'s :hover rule too, and one restore puts every byte back', () => {
    const result = batch(addDanger())
    expect(result.refusals).toEqual([])
    expect(read('components/Chip.module.css')).toBe(
      [
        '.info {',
        '  color: blue;',
        '}',
        '',
        '.danger {',
        '  color: blue;',
        '}',
        '',
        '.danger:hover {',
        '  color: navy;',
        '}',
        '',
        '.info:hover {',
        '  color: navy;',
        '}',
        '',
        '.warn {',
        '  color: orange;',
        '}',
        '',
        '.warn:hover,',
        '.warn:focus-visible {',
        '  color: darkorange;',
        '}',
        '',
      ].join('\n'),
    )
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/Chip.module.css')).toBe(STATEFUL_CSS)
  })

  it('Remove variant takes the value\'s rule and every state of it, and one restore brings them back', () => {
    write('pages/Home.tsx', HOME.replace('tone="warn"', 'tone="info"'))
    const result = batch({ kind: 'remove-variant', nodeId: idOf('components/Chip.tsx', 'Chip('), exportName: 'Chip', prop: 'tone', name: 'warn' })
    expect(result.refusals).toEqual([])
    expect(read('components/Chip.module.css')).toBe(['.info {', '  color: blue;', '}', '', '.info:hover {', '  color: navy;', '}', ''].join('\n'))
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/Chip.module.css')).toBe(STATEFUL_CSS)
  })
})

describe('add-component-prop', () => {
  const BADGE = "export function Badge({ label }: { label: string }) {\n  return <b>{label}</b>\n}\n"
  const badgeId = () => idOf('components/Badge.tsx', 'Badge(')

  it('adds an optional boolean with a default to the signature and its type, nothing at the call sites', () => {
    write('components/Badge.tsx', BADGE)
    write('pages/Home.tsx', "import { Badge } from '../components/Badge'\nexport default function Home() {\n  return <Badge label=\"x\" />\n}\n")
    const home = read('pages/Home.tsx')
    const result = batch({ kind: 'add-component-prop', nodeId: badgeId(), exportName: 'Badge', name: 'solid', propType: { kind: 'boolean', defaultValue: false } })
    expect(result.refusals).toEqual([])
    expect(read('components/Badge.tsx')).toBe("export function Badge({ label, solid = false }: { label: string; solid?: boolean }) {\n  return <b>{label}</b>\n}\n")
    expect(read('pages/Home.tsx')).toBe(home)
    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('components/Badge.tsx')).toBe(BADGE)
  })

  it('adds a variant prop as an inline union whose first member is the default', () => {
    write('components/Badge.tsx', BADGE)
    const result = batch({ kind: 'add-component-prop', nodeId: badgeId(), exportName: 'Badge', name: 'size', propType: { kind: 'variant', members: ['sm', 'md', 'lg'] } })
    expect(result.refusals).toEqual([])
    expect(read('components/Badge.tsx')).toContain("{ label, size = 'sm' }: { label: string; size?: 'sm' | 'md' | 'lg' }")
  })

  it('adds a text prop in the file\'s own quote', () => {
    write('components/Badge.tsx', 'import { useId } from "react"\nexport function Badge({ label }: { label: string }) {\n  return <b>{label}</b>\n}\n')
    const result = batch({ kind: 'add-component-prop', nodeId: badgeId(), exportName: 'Badge', name: 'hint', propType: { kind: 'text', defaultValue: 'Hello' } })
    expect(result.refusals).toEqual([])
    expect(read('components/Badge.tsx')).toContain('{ label, hint = "Hello" }: { label: string; hint?: string }')
  })

  it('writes an untyped JS component\'s binding and no type', () => {
    write('components/Badge.jsx', 'export function Badge({ label }) {\n  return <b>{label}</b>\n}\n')
    const result = batch({ kind: 'add-component-prop', nodeId: idOf('components/Badge.jsx', 'Badge('), exportName: 'Badge', name: 'solid', propType: { kind: 'boolean', defaultValue: true } })
    expect(result.refusals).toEqual([])
    expect(read('components/Badge.jsx')).toBe('export function Badge({ label, solid = true }) {\n  return <b>{label}</b>\n}\n')
  })

  it('refuses a name the component already takes, a reserved word, and an undestructured props parameter', () => {
    write('components/Badge.tsx', BADGE)
    write('components/Raw.tsx', 'export function Raw(props: { a: string }) {\n  return <b>{props.a}</b>\n}\n')
    const before = snapshot()
    for (const [edit, reason] of [
      [{ kind: 'add-component-prop', nodeId: badgeId(), exportName: 'Badge', name: 'label', propType: { kind: 'boolean', defaultValue: false } }, 'prop-exists'],
      [{ kind: 'add-component-prop', nodeId: badgeId(), exportName: 'Badge', name: 'class', propType: { kind: 'boolean', defaultValue: false } }, 'invalid-prop-name'],
      [{ kind: 'add-component-prop', nodeId: idOf('components/Raw.tsx', 'Raw('), exportName: 'Raw', name: 'solid', propType: { kind: 'boolean', defaultValue: false } }, 'unsupported-params'],
    ] as const) {
      const result = batch(edit)
      expect(result.written).toBe(0)
      expect(result.refusals.map((refusal) => refusal.reason)).toEqual([reason])
    }
    expect(snapshot()).toEqual(before)
  })
})
