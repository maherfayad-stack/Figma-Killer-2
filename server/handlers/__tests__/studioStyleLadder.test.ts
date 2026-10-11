/**
 * G-5 — a style edit lands on a ladder, on the wire: the first honest rung
 * wins, the batch says which one (`styleLandings`), and the two rungs a plain
 * "set the old value back" cannot undo (an expanded shorthand, an override) are
 * journaled so one restore puts every byte back.
 *
 * Every case runs against a REAL temp project through `applyStudioEditBatch`,
 * the engine the `/save` route and the MCP tool share. The fixtures are a
 * pricing card and a toggle — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Project } from 'ts-morph'
import { extractCssInJs } from '@core/page-parser'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'
import { restoreUndoJournal } from '../studio/undoJournal'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

/** A `css` set edit for `.plan` in `styles/Plan.css`. */
function cssSet(property: string, value: string, atRule?: string): StudioEdit {
  return {
    kind: 'css',
    op: 'set',
    nodeId: `css:styles/Plan.css#.plan#${atRule ?? ''}#${property}`,
    file: 'styles/Plan.css',
    selector: '.plan',
    property,
    value,
    ...(atRule ? { atRule } : {}),
  }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-style-ladder-')))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the .css rungs, on the wire', () => {
  it('rung 1 — the winning declaration is rewritten: reported as the rule, nothing journaled', () => {
    const css = '.plan {\n  color: red;\n  padding: 8px;\n}\n'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('color', 'navy')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe('.plan {\n  color: navy;\n  padding: 8px;\n}\n')
    expect(result.styleLandings).toEqual([
      { nodeId: 'css:styles/Plan.css#.plan##color', rung: 'rule', file: 'styles/Plan.css' },
    ])
    // A rewrite is undone by writing the old value back; it costs the journal nothing.
    expect(result.undoToken).toBeUndefined()
    // …and the file really is shorter on the journal side: writing it back is exact.
    const back = applyStudioEditBatch(dir, [cssSet('color', 'red')], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('a property the rule never set is added to the rule: still rung 1, and clearing it is byte-exact', () => {
    const css = '.plan {\n  color: red;\n}\n'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('margin', '0')], {}, EDITOR)
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['rule'])
    expect(result.undoToken).toBeUndefined()
    const clear = applyStudioEditBatch(
      dir,
      [{ kind: 'css', op: 'unset', nodeId: 'css:styles/Plan.css#.plan##margin', file: 'styles/Plan.css', selector: '.plan', property: 'margin' }],
      {},
      EDITOR,
    )
    expect(clear.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('rung 2 — a longhand after the shorthand it overrides: reported as an override, journaled, restored byte for byte', () => {
    const css = '.plan {\n  padding: 8px;\n  color: red;\n}\n'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('padding-top', '20px')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe('.plan {\n  padding: 8px;\n  padding-top: 20px;\n  color: red;\n}\n')
    expect(result.styleLandings).toEqual([
      { nodeId: 'css:styles/Plan.css#.plan##padding-top', rung: 'override', file: 'styles/Plan.css' },
    ])
    expect(result.undoToken).toMatch(/^[0-9a-f]{32}$/)

    const undone = applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR)
    expect(undone.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('rung 1, expanded — a covering !important shorthand is rewritten in place: reported as expanded, journaled, restored byte for byte', () => {
    const css = '.plan {\n  padding: 4px 8px !important;\n  color: red;\n}\n'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('padding-top', '20px')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe('.plan {\n  padding: 20px 8px 4px !important;\n  color: red;\n}\n')
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['expanded'])
    expect(result.undoToken).toBeDefined()

    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('rung 2, important — a shorthand it cannot read side by side is beaten by an !important longhand, and restores exactly', () => {
    const css = '.plan {\n  background: var(--card) !important;\n}\n'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('background-color', 'white')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe('.plan {\n  background: var(--card) !important;\n  background-color: white !important;\n}\n')
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['override'])
    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('an override inside a @media block lands in that block and restores exactly', () => {
    const css = '@media (max-width: 600px) {\n  .plan {\n    margin: 4px;\n  }\n}\n'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('margin-left', '0', 'media (max-width: 600px)')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(
      '@media (max-width: 600px) {\n  .plan {\n    margin: 4px;\n    margin-left: 0;\n  }\n}\n',
    )
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['override'])
    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('the restore is compare-and-swap: a later write to the stylesheet makes it refuse, naming the file and writing nothing', () => {
    write('styles/Plan.css', '.plan {\n  padding: 8px;\n}\n')
    const first = applyStudioEditBatch(dir, [cssSet('padding-top', '20px')], {}, EDITOR)
    applyStudioEditBatch(dir, [cssSet('color', 'navy')], {}, EDITOR)
    const after = read('styles/Plan.css')
    const undone = applyStudioEditBatch(dir, [restore(first.undoToken!)], {}, EDITOR)
    expect(undone.refusals.map((refusal) => refusal.reason)).toEqual(['restore-stale'])
    expect(undone.refusals[0]!.message).toContain('styles/Plan.css')
    expect(read('styles/Plan.css')).toBe(after)
  })

  it('an unparseable stylesheet still refuses by name and is left byte-identical', () => {
    const css = '.plan { color: red'
    write('styles/Plan.css', css)
    const result = applyStudioEditBatch(dir, [cssSet('color', 'navy')], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['css-syntax'])
    expect(result.styleLandings).toEqual([])
    expect(result.undoToken).toBeUndefined()
    expect(read('styles/Plan.css')).toBe(css)
  })

  it('a batch that also invents a stylesheet restores to a project without it', () => {
    const page = "export default function Home() {\n  return <main className=\"fresh\">Hi</main>\n}\n"
    const plan = '.plan {\n  padding: 8px;\n}\n'
    write('pages/Home.tsx', page)
    write('styles/Plan.css', plan)
    const result = applyStudioEditBatch(
      dir,
      [
        { kind: 'css', op: 'create', nodeId: 'css:create:fresh', pageFile: 'pages/Home.tsx', selector: '.fresh', declarations: { color: 'red' } },
        cssSet('padding-top', '20px'),
      ],
      {},
      EDITOR,
    )
    expect(result.refusals).toEqual([])
    expect(fs.existsSync(abs('pages/Home.css'))).toBe(true)
    expect(read('pages/Home.tsx')).toContain("import './Home.css'")
    expect(result.undoToken).toBeDefined()

    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(fs.existsSync(abs('pages/Home.css'))).toBe(false)
    expect(read('pages/Home.tsx')).toBe(page)
    expect(read('styles/Plan.css')).toBe(plan)
  })

  it('an agent batch (no journal option) reports the landing but records no entry', () => {
    write('styles/Plan.css', '.plan {\n  padding: 8px;\n}\n')
    const result = applyStudioEditBatch(dir, [cssSet('padding-top', '20px')], {}, { canvasLayers: 'allow' })
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['override'])
    expect(result.undoToken).toBeUndefined()
    expect(fs.existsSync(abs('.studio/undo-journal'))).toBe(false)
  })
})

describe('the styled-template rungs, on the wire', () => {
  const IMPORT = "import styled from 'styled-components'\n"

  /** A styled `Toggle` and the `styled` edit that targets it. */
  function toggle(source: string): { edit: (property: string, value: string) => StudioEdit; text: string } {
    write('src/Toggle.tsx', source)
    const project = new Project({ useInMemoryFileSystem: false })
    const extracted = extractCssInJs(project.addSourceFileAtPath(abs('src/Toggle.tsx')), 'src/Toggle.tsx')
    const template = extracted.extraction.templates.find((entry) => entry.componentName === 'Toggle')!
    return {
      text: source,
      edit: (property, value) => ({
        kind: 'styled',
        nodeId: `src/Toggle.tsx:${template.loc.line}:${template.loc.col}`,
        className: template.className,
        selector: `.${template.className}`,
        property,
        value,
      }),
    }
  }

  it('rung 1 — a literal is rewritten in the template: reported as the rule, nothing journaled', () => {
    const { edit } = toggle(`${IMPORT}export const Toggle = styled.button\`\n  color: red;\n\``)
    const result = applyStudioEditBatch(dir, [edit('color', 'navy')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('src/Toggle.tsx')).toBe(`${IMPORT}export const Toggle = styled.button\`\n  color: navy;\n\``)
    expect(result.styleLandings.map((landing) => [landing.rung, landing.file])).toEqual([['rule', 'src/Toggle.tsx']])
    expect(result.undoToken).toBeUndefined()
  })

  it('rung 2 — an interpolated value is left alone and overridden: journaled, restored byte for byte', () => {
    const source = `${IMPORT}const GAP = '8px'\nexport const Toggle = styled.button\`\n  padding: \${GAP};\n\``
    const { edit } = toggle(source)
    const result = applyStudioEditBatch(dir, [edit('padding', '20px')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('src/Toggle.tsx')).toBe(`${IMPORT}const GAP = '8px'\nexport const Toggle = styled.button\`\n  padding: \${GAP};\n  padding: 20px;\n\``)
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['override'])
    expect(result.undoToken).toBeDefined()
    expect(applyStudioEditBatch(dir, [restore(result.undoToken!)], {}, EDITOR).refusals).toEqual([])
    expect(read('src/Toggle.tsx')).toBe(source)
  })

  it('a property the template never writes is added to it: the rule, not an override', () => {
    const { edit } = toggle(`${IMPORT}export const Toggle = styled.button\`\n  color: red;\n\``)
    const result = applyStudioEditBatch(dir, [edit('border-radius', '999px')], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('src/Toggle.tsx')).toBe(`${IMPORT}export const Toggle = styled.button\`\n  color: red;\n  border-radius: 999px;\n\``)
    expect(result.styleLandings.map((landing) => landing.rung)).toEqual(['rule'])
  })

  it('a value no template literal can hold is the one thing left that refuses — by name, nothing written', () => {
    const { edit, text } = toggle(`${IMPORT}export const Toggle = styled.button\`\n  color: red;\n\``)
    const result = applyStudioEditBatch(dir, [edit('content', '"\\201C"')], {}, EDITOR)
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual(['unwritable-value'])
    expect(result.styleLandings).toEqual([])
    expect(read('src/Toggle.tsx')).toBe(text)
  })
})

describe('the inline rung, on the wire', () => {
  it('a style edit reports itself as inline, in the file holding the element', () => {
    const source = 'export default function Plan() {\n  return <section className="plan">Pro</section>\n}\n'
    write('src/Plan.tsx', source)
    const nodeId = 'src/Plan.tsx:2:11'
    const result = applyStudioEditBatch(dir, [{ kind: 'style', nodeId, style: { color: 'navy' } }], {}, EDITOR)
    expect(result.refusals).toEqual([])
    expect(read('src/Plan.tsx')).toMatch(/style=\{\{ color: ["']navy["'] \}\}/)
    expect(result.styleLandings).toEqual([{ nodeId, rung: 'inline', file: 'src/Plan.tsx' }])
    // The inline layer is the element's own; a value write undoes it.
    expect(result.undoToken).toBeUndefined()
  })
})

describe('the journal still refuses to name anything but source and a hand-authored stylesheet', () => {
  /** Plants an entry the way a clone with a hostile `.studio/` could, then asks for it back. */
  function plant(rel: string, before: string, afterOnDisk: string | null): string {
    const token = '0000000000010123456789abcdef0123'
    const sha = afterOnDisk === null ? null : createHash('sha256').update(afterOnDisk).digest('hex')
    write(`.studio/undo-journal/${token}.json`, JSON.stringify({ version: 1, at: Date.now(), files: [{ rel, before, afterSha256: sha }] }))
    return token
  }

  it.each([
    ['a path out of the project', '../outside.css'],
    ['a stylesheet under node_modules', 'node_modules/pkg/theme.css'],
    ['a minified build artefact', 'public/app.min.css'],
    ['the studio store itself', '.studio/meta.json.css'],
    ['a file that is not source or a stylesheet', 'package.json'],
  ])('restore of an entry naming %s writes nothing', (_name, rel) => {
    const planted = plant(rel, 'x', null)
    const result = restoreUndoJournal(dir, planted)
    expect(result).toMatchObject({ ok: false, reason: 'restore-unavailable' })
    expect(fs.existsSync(path.resolve(dir, rel))).toBe(false)
  })

  it('restore of an entry that names a stylesheet reached through a link writes nothing through it', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-style-outside-')))
    try {
      fs.writeFileSync(path.join(outside, 'theme.css'), 'safe')
      try {
        fs.symlinkSync(outside, abs('linked'), 'junction')
      } catch {
        return // no permission to link on this machine: the guard is exercised by the cases above
      }
      const planted = plant('linked/theme.css', 'pwned', 'safe')
      expect(restoreUndoJournal(dir, planted)).toMatchObject({ ok: false, reason: 'restore-unavailable' })
      expect(fs.readFileSync(path.join(outside, 'theme.css'), 'utf8')).toBe('safe')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('restore of an entry that names a real stylesheet still works (the new door is open for that and no wider)', () => {
    write('styles/Plan.css', 'AFTER')
    const planted = plant('styles/Plan.css', 'BEFORE', 'AFTER')
    expect(restoreUndoJournal(dir, planted)).toMatchObject({ ok: true })
    expect(read('styles/Plan.css')).toBe('BEFORE')
  })
})
