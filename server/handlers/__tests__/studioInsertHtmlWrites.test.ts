/**
 * G-10 through the real save batch: pasting HTML onto a board backed by real
 * files is ONE journaled write - the elements into the page's JSX, the CSS that
 * came with them into the stylesheet the page imports (or onto the elements when
 * it imports none) - and one `restore` puts every file back, byte for byte.
 *
 * Driven against a temp project on disk with the journal on, exactly as the
 * editor's `/save` route runs a batch. The fixture shares nothing with the eSIM
 * corpus: a pottery studio's class-booking pages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyStudioEditBatch, type StudioEdit } from '../studioWriteback'
import { locateTag } from '../../../src/core/ast-codemods/__tests__/fixtureLocation'

let dir: string

const abs = (rel: string) => path.join(dir, ...rel.split('/'))
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
  fs.writeFileSync(abs(rel), text)
}
const journal = () => (fs.existsSync(abs('.studio/undo-journal')) ? fs.readdirSync(abs('.studio/undo-journal')) : [])

const EDITOR = { canvasLayers: 'allow', journal: true } as const
const restore = (token: string): StudioEdit => ({ kind: 'restore', nodeId: `undo-journal:${token}`, token })

const GLOBAL_PAGE = `import './classes.css'

export default function Classes() {
  return (
    <main className="shelf">
      <h1>Wheel classes</h1>
      <p className="note">Tuesdays and Thursdays</p>
    </main>
  )
}
`
const GLOBAL_CSS = `.shelf {
  display: grid;
  gap: 16px;
}

.note {
  color: #57534e;
}
`

const MODULE_PAGE = `import styles from './Kiln.module.css'

export default function Kiln() {
  return (
    <section className={styles.wrap}>
      <h1>Kiln nights</h1>
    </section>
  )
}
`
const MODULE_CSS = `.wrap {
  padding: 24px;
}
`

const BARE_PAGE = `export default function Glazes() {
  return (
    <div>
      <h1>Glazes</h1>
    </div>
  )
}
`

function nodeId(rel: string, source: string, tag: string, occurrence = 1): string {
  const { line, col } = locateTag(source, tag, occurrence)
  return `${rel}:${line}:${col}`
}

function paste(rel: string, source: string, into: string, html: Omit<Extract<StudioEdit, { kind: 'insert' }>, 'kind' | 'nodeId'>): StudioEdit {
  return { kind: 'insert', nodeId: nodeId(rel, source, into), ...html }
}

const SLOT_CSS = `.slot { padding: 8px 12px; border: 1px solid #d6d3d1 }
.slot a:hover { color: #b91c1c }
a { color: royalblue }
body { margin: 0 }
@media (max-width: 600px) { .slot { padding: 4px } }
@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }`

const SLOT_NODE = {
  name: 'div',
  props: { className: 'slot' },
  children: [{ name: 'a', props: { href: '/book/wheel-101' }, children: 'Book wheel 101' }],
} as const

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'insert-html-writes-')))
  write('pages/Classes.tsx', GLOBAL_PAGE)
  write('pages/classes.css', GLOBAL_CSS)
  write('pages/Kiln.tsx', MODULE_PAGE)
  write('pages/Kiln.module.css', MODULE_CSS)
  write('pages/Glazes.tsx', BARE_PAGE)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pasted HTML into a page that imports a plain stylesheet', () => {
  it('writes the elements and the scoped rules, and says what it skipped', () => {
    const result = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { ...SLOT_NODE, pastedHtml: { css: SLOT_CSS } })],
      {},
      EDITOR,
    )

    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Classes.tsx')).toBe(`import './classes.css'

export default function Classes() {
  return (
    <main className="shelf">
      <h1>Wheel classes</h1>
      <p className="note">Tuesdays and Thursdays</p>
      <div className="slot">
        <a href="/book/wheel-101">Book wheel 101</a>
      </div>
    </main>
  )
}
`)
    expect(read('pages/classes.css')).toBe(`${GLOBAL_CSS}
.slot {
  padding: 8px 12px;
  border: 1px solid #d6d3d1;
}

.slot a:hover {
  color: #b91c1c;
}

@media (max-width: 600px) {
  .slot {
    padding: 4px;
  }
}
`)
    expect(result.pastedHtml).toEqual([
      {
        stylesheet: 'pages/classes.css',
        mode: 'global',
        rules: 3,
        inlined: 0,
        renamed: [],
        skipped: ['@keyframes pulse', 'a', 'body'],
        droppedDeclarations: 0,
      },
    ])
    expect(result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')).sort()).toEqual([
      'pages/Classes.tsx',
      'pages/classes.css',
    ])
    // One root element, however deep it goes: the board selects the paste's root.
    expect(result.createdNodeIds).toHaveLength(1)
  })

  it('one restore puts the page and the stylesheet back byte for byte', () => {
    const forward = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { ...SLOT_NODE, pastedHtml: { css: SLOT_CSS } })],
      {},
      EDITOR,
    )
    expect(forward.undoToken).toBeDefined()
    expect(journal()).toHaveLength(1)

    const back = applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(back.refusals).toEqual([])
    expect(read('pages/Classes.tsx')).toBe(GLOBAL_PAGE)
    expect(read('pages/classes.css')).toBe(GLOBAL_CSS)
  })

  it('renames a class the project already has instead of restyling the existing one', () => {
    const result = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { name: 'p', props: { className: 'note' }, children: 'Pasted note', pastedHtml: { css: '.note { color: tomato; font-weight: 700 }' } })],
      {},
      EDITOR,
    )

    expect(result.refusals).toEqual([])
    expect(read('pages/Classes.tsx')).toContain('<p className="note-2">Pasted note</p>')
    expect(read('pages/Classes.tsx')).toContain('<p className="note">Tuesdays and Thursdays</p>')
    const css = read('pages/classes.css')
    expect(css.startsWith(GLOBAL_CSS)).toBe(true)
    expect(css).toContain('.note-2 {\n  color: tomato;\n  font-weight: 700;\n}')
    expect(result.pastedHtml?.[0]?.renamed).toEqual([{ from: 'note', to: 'note-2' }])
  })

  it('renames a class that another source file uses even though no stylesheet defines it', () => {
    write('pages/Other.tsx', 'export default function Other() {\n  return <div className="slot chip">x</div>\n}\n')
    applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { ...SLOT_NODE, pastedHtml: { css: '.slot { padding: 8px }' } })],
      {},
      EDITOR,
    )
    expect(read('pages/Classes.tsx')).toContain('<div className="slot-2">')
    expect(read('pages/classes.css')).toContain('.slot-2 {')
  })

  it('renames a class the project uses only through clsx or a template string, never merging into the user rule', () => {
    write('pages/Other.tsx', `import clsx from 'clsx'
export default function Other({ on }: { on: boolean }) {
  return <div className={clsx('base', on && 'card')}>x</div>
}
`)
    write('pages/classes.css', `${GLOBAL_CSS}
.card {
  color: green;
}
`)
    const before = read('pages/classes.css')
    const result = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { name: 'div', props: { className: 'card' }, children: 'x', pastedHtml: { css: '.card { color: red }' } })],
      {},
      EDITOR,
    )
    expect(result.refusals).toEqual([])
    expect(read('pages/Classes.tsx')).toContain('<div className="card-2">x</div>')
    expect(read('pages/classes.css')).toBe(`${before}
.card-2 {
  color: red;
}
`)
    expect(read('pages/classes.css')).toContain(`.card {
  color: green;
}`)
  })

  it('renames a class used only in a template string of another file', () => {
    write('pages/Other.tsx', 'export const tone = (x: string) => `tile ${x} card`' + String.fromCharCode(10))
    applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { name: 'div', props: { className: 'tile' }, children: 'x', pastedHtml: { css: '.tile { color: red }' } })],
      {},
      EDITOR,
    )
    expect(read('pages/Classes.tsx')).toContain('className="tile-2"')
  })

  it('a rule that names none of the paste classes is never written', () => {
    const result = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { ...SLOT_NODE, pastedHtml: { css: 'h1 { font-size: 40px } * { box-sizing: border-box } :root { --gap: 8px } .other + p { margin: 0 } .slot + p { margin: 0 }' } })],
      {},
      EDITOR,
    )
    expect(read('pages/classes.css')).toBe(GLOBAL_CSS)
    expect(result.pastedHtml?.[0]).toMatchObject({ mode: 'none', rules: 0 })
    expect(result.pastedHtml?.[0]?.skipped).toEqual(['h1', '*', ':root', '.other + p', '.slot + p'])
  })

  it('drops a declaration that loads an external resource and counts it, and refuses @import', () => {
    const result = applyStudioEditBatch(
      dir,
      [
        paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', {
          ...SLOT_NODE,
          pastedHtml: {
            css: '@import url(https://evil.example/x.css); .slot { color: red; background: url(https://tracker.example/p.gif); width: expression(alert(1)); behavior: url(x.htc) }',
          },
        }),
      ],
      {},
      EDITOR,
    )
    expect(read('pages/classes.css')).toBe(`${GLOBAL_CSS}\n.slot {\n  color: red;\n}\n`)
    expect(result.pastedHtml?.[0]?.skipped).toEqual(['@import url(https://evil.example/x.css)'])
    expect(result.pastedHtml?.[0]?.droppedDeclarations).toBe(3)
  })

  it('writes several roots in order beside an anchor, in one splice', () => {
    const anchor = nodeId('pages/Classes.tsx', GLOBAL_PAGE, 'h1')
    const result = applyStudioEditBatch(
      dir,
      [
        paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', {
          name: 'h2',
          children: 'First',
          siblings: [{ name: 'h3', children: 'Second' }, { name: 'hr' }],
          anchorNodeId: anchor,
          position: 'after',
          pastedHtml: {},
        }),
      ],
      {},
      EDITOR,
    )
    expect(result.refusals).toEqual([])
    expect(read('pages/Classes.tsx')).toContain(`      <h1>Wheel classes</h1>
      <h2>First</h2>
      <h3>Second</h3>
      <hr />
      <p className="note">`)
    expect(result.createdNodeIds).toHaveLength(3)
  })
})

describe('pasted HTML into a page that imports a CSS Module', () => {
  it('reaches the rules through the module binding the page already has', () => {
    const result = applyStudioEditBatch(
      dir,
      [
        paste('pages/Kiln.tsx', MODULE_PAGE, 'section', {
          name: 'div',
          props: { className: 'slot big-slot' },
          children: [{ name: 'span', props: { className: 'slot-label wide' }, children: 'Thursday' }],
          pastedHtml: { css: '.slot { padding: 8px } .big-slot { font-size: 20px } .slot-label { font-weight: 700 }' },
        }),
      ],
      {},
      EDITOR,
    )

    expect(result.refusals).toEqual([])
    expect(read('pages/Kiln.tsx')).toBe(`import styles from './Kiln.module.css'

export default function Kiln() {
  return (
    <section className={styles.wrap}>
      <h1>Kiln nights</h1>
      <div className={\`\${styles.slot} \${styles["big-slot"]}\`}>
        <span className={\`\${styles["slot-label"]} wide\`}>Thursday</span>
      </div>
    </section>
  )
}
`)
    expect(read('pages/Kiln.module.css')).toBe(`${MODULE_CSS}
.slot {
  padding: 8px;
}

.big-slot {
  font-size: 20px;
}

.slot-label {
  font-weight: 700;
}
`)
    expect(result.pastedHtml?.[0]).toMatchObject({ stylesheet: 'pages/Kiln.module.css', mode: 'module', rules: 3 })
  })

  it('renames only against the module file itself (its names are local to it)', () => {
    write('pages/Other.tsx', 'export default function Other() {\n  return <div className="slot">x</div>\n}\n')
    applyStudioEditBatch(
      dir,
      [paste('pages/Kiln.tsx', MODULE_PAGE, 'section', { name: 'div', props: { className: 'wrap' }, children: 'x', pastedHtml: { css: '.wrap { margin: 0 }' } })],
      {},
      EDITOR,
    )
    expect(read('pages/Kiln.tsx')).toContain('<div className={styles["wrap-2"]}>x</div>')
    expect(read('pages/Kiln.module.css')).toBe(`${MODULE_CSS}\n.wrap-2 {\n  margin: 0;\n}\n`)
  })

  it('restores the page and the module byte for byte', () => {
    const forward = applyStudioEditBatch(
      dir,
      [paste('pages/Kiln.tsx', MODULE_PAGE, 'section', { name: 'p', props: { className: 'lead' }, children: 'x', pastedHtml: { css: '.lead { color: red }' } })],
      {},
      EDITOR,
    )
    applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(read('pages/Kiln.tsx')).toBe(MODULE_PAGE)
    expect(read('pages/Kiln.module.css')).toBe(MODULE_CSS)
  })
})

describe('pasted HTML into a page with no stylesheet', () => {
  it('resolves single-class rules onto the elements and reports what it cannot', () => {
    const result = applyStudioEditBatch(
      dir,
      [
        paste('pages/Glazes.tsx', BARE_PAGE, 'div', {
          name: 'div',
          props: { className: 'swatch featured', style: { color: 'navy' } },
          children: 'Celadon',
          pastedHtml: { css: '.swatch { padding: 8px; color: red } .featured { border: 2px solid gold } .swatch:hover { color: blue }' },
        }),
      ],
      {},
      EDITOR,
    )
    expect(result.refusals).toEqual([])
    expect(read('pages/Glazes.tsx')).toContain(
      '<div style={{ padding: "8px", color: "navy", border: "2px solid gold" }}>Celadon</div>',
    )
    expect(fs.readdirSync(abs('pages')).sort()).toEqual(['Classes.tsx', 'Glazes.tsx', 'Kiln.module.css', 'Kiln.tsx', 'classes.css'])
    expect(result.pastedHtml?.[0]).toMatchObject({ stylesheet: null, mode: 'inline', rules: 0, inlined: 2, skipped: ['.swatch:hover'] })
    expect(result.touchedFiles.map((file) => path.basename(file))).toEqual(['Glazes.tsx'])
  })

  it('restores the page byte for byte', () => {
    const forward = applyStudioEditBatch(
      dir,
      [paste('pages/Glazes.tsx', BARE_PAGE, 'div', { name: 'p', props: { className: 'a' }, children: 'x', pastedHtml: { css: '.a { color: red }' } })],
      {},
      EDITOR,
    )
    applyStudioEditBatch(dir, [restore(forward.undoToken!)], {}, EDITOR)
    expect(read('pages/Glazes.tsx')).toBe(BARE_PAGE)
  })

  it('leaves markup with no stylesheet text exactly as converted', () => {
    applyStudioEditBatch(
      dir,
      [paste('pages/Glazes.tsx', BARE_PAGE, 'div', { name: 'p', props: { className: 'tailwind-ish p-4' }, children: 'x', pastedHtml: {} })],
      {},
      EDITOR,
    )
    expect(read('pages/Glazes.tsx')).toContain('<p className="tailwind-ish p-4">x</p>')
  })
})

describe('hostile pasted input is refused whole', () => {
  const refuses = (node: Parameters<typeof paste>[3]): void => {
    const result = applyStudioEditBatch(dir, [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', node)], {}, EDITOR)
    expect(result.written).toBe(0)
    expect(result.refusals).toHaveLength(1)
    expect(result.refusals[0]!.reason).toBe('unsafe-paste')
    expect(read('pages/Classes.tsx')).toBe(GLOBAL_PAGE)
    expect(read('pages/classes.css')).toBe(GLOBAL_CSS)
    expect(journal()).toEqual([])
  }

  it('an event handler prop', () => refuses({ name: 'img', props: { src: 'x', onError: 'alert(1)' }, pastedHtml: {} }))
  it('a javascript: href', () => refuses({ name: 'a', props: { href: ' JaVaScRiPt:alert(1)' }, children: 'x', pastedHtml: {} }))
  it('a script element', () => refuses({ name: 'script', children: 'alert(1)', pastedHtml: {} }))
  it('an iframe, however nested', () =>
    refuses({ name: 'div', children: [{ name: 'section', children: [{ name: 'iframe', props: { src: 'https://evil.example' } }] }], pastedHtml: {} }))
  it('dangerouslySetInnerHTML and srcDoc', () => {
    refuses({ name: 'div', props: { dangerouslySetInnerHTML: { __html: '<b>x</b>' } }, pastedHtml: {} })
    refuses({ name: 'div', props: { srcDoc: '<script>1</script>' }, pastedHtml: {} })
  })
  it('a component with an import', () => refuses({ name: 'Button', importSpecifier: 'evil-lib', pastedHtml: {} }))
  it('a non-image data: URL', () => refuses({ name: 'a', props: { href: 'data:text/html;base64,PHNjcmlwdD4=' }, children: 'x', pastedHtml: {} }))
  it('a style value that loads a resource', () =>
    refuses({ name: 'div', props: { style: { background: 'url(https://tracker.example/p.gif)' } }, pastedHtml: {} }))
  it('a React-reserved prop', () => refuses({ name: 'div', props: { ref: 'x' }, pastedHtml: {} }))
  it('attribute case does not matter: HREF, an uppercase ACTION on a form, xlinkHref, a control character before the scheme', () => {
    refuses({ name: 'a', props: { HREF: 'javascript:alert(1)' }, children: 'x', pastedHtml: {} })
    refuses({ name: 'form', props: { ACTION: 'javascript:alert(1)' }, pastedHtml: {} })
    refuses({ name: 'a', props: { xlinkHref: 'javascript:alert(1)' }, children: 'x', pastedHtml: {} })
    refuses({ name: 'a', props: { href: 'javascript:alert(1)' }, children: 'x', pastedHtml: {} })
  })
  it('an <animate> that sets href from values', () =>
    refuses({ name: 'svg', children: [{ name: 'a', children: [{ name: 'animate', props: { attributeName: 'href', values: 'javascript:alert(1)' } }] }], pastedHtml: {} }))

  it('an oversized paste', () => {
    const children = Array.from({ length: 1600 }, () => ({ name: 'li' }))
    refuses({ name: 'ul', children, pastedHtml: {} })
  })

  it('an agent batch (no journal) writes the same way and records no journal entry', () => {
    const result = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { ...SLOT_NODE, pastedHtml: { css: '.slot { padding: 8px }' } })],
      {},
      {},
    )
    expect(result.written).toBe(1)
    expect(result.undoToken).toBeUndefined()
    expect(journal()).toEqual([])
  })
})

describe('a stylesheet that cannot be written', () => {
  it('puts the page back and refuses by name, leaving both files as they were', () => {
    const broken = ['.shelf {', '  display: grid', ''].join('\n')
    write('pages/classes.css', broken)
    const result = applyStudioEditBatch(
      dir,
      [paste('pages/Classes.tsx', GLOBAL_PAGE, 'main', { ...SLOT_NODE, pastedHtml: { css: '.slot { padding: 8px }' } })],
      {},
      EDITOR,
    )
    expect(result.written).toBe(0)
    expect(result.refusals[0]!.reason).toBe('stylesheet-write-failed')
    expect(read('pages/Classes.tsx')).toBe(GLOBAL_PAGE)
    expect(read('pages/classes.css')).toBe(broken)
    expect(journal()).toEqual([])
  })
})
