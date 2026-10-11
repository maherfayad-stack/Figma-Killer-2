/**
 * §4 — host tag → moduleId mapping for imported pages.
 *
 * The rule this protects: `base.text` and `base.button` are both leaves
 * (`canHaveChildren: false`) and both render a hardcoded placeholder — the
 * literal words "Text" and "Button" — when their content prop is empty. So
 * they may only be chosen for an element that actually has text and no element
 * children. Everything else becomes `base.container`, which preserves the real
 * host tag and renders children.
 *
 * Regression pressure is real: the original rule mapped `button` before it
 * checked for children, and mapped every childless element to `base.text`
 * regardless of whether it had any. On the eSIM corpus that produced 154 nodes
 * rendering the word "Text", 21 rendering "Button", and 10 buttons silently
 * dropping their children. Exercised through `loadStudioPages` because
 * `resolveModuleId` is private to the pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@core/page-tree'
import { loadStudioPages } from '../studioPageLoad'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mapping-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Writes a one-page workspace whose component body is `jsx`, and loads it. */
async function loadPageWith(jsx: string): Promise<Page> {
  const full = path.join(tmpDir, 'pages', 'Home.jsx')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, ['export default function Home() {', `  return (${jsx})`, '}', ''].join('\n'), 'utf8')
  const { pages } = await loadStudioPages(tmpDir)
  return pages[0]!
}

/**
 * All non-body nodes as `tag:moduleId` pairs (bare `moduleId` when the module's
 * own default tag applies), in node-insertion order — children before parents.
 */
function mapping(page: Page): string[] {
  return Object.values(page.nodes)
    .filter((n) => n.moduleId !== 'base.body')
    .map((n) => {
      const tag = n.props.customTag ?? n.props.tag
      return typeof tag === 'string' ? `${tag}:${n.moduleId}` : n.moduleId
    })
}

describe('resolveModuleId — leaf modules only for elements that have text', () => {
  it('maps a text-only element to base.text', async () => {
    // No `p:` prefix — `p` is base.text's own default, so no tag prop is written.
    const page = await loadPageWith('<p>Hello</p>')
    expect(mapping(page)).toEqual(['base.text'])
  })

  it('maps an EMPTY element to base.container, not base.text', async () => {
    // `<span className="icon" />` is an icon slot drawn entirely by CSS. As
    // base.text it would render the literal word "Text".
    const page = await loadPageWith('<span className="icon" />')
    expect(mapping(page)).toEqual(['span:base.container'])
  })

  it('maps a whitespace-only element to base.container', async () => {
    const page = await loadPageWith('<p>   </p>')
    expect(mapping(page)).toEqual(['p:base.container'])
  })

  it('promotes a text-ish element that wraps children to base.container, keeping its tag', async () => {
    const page = await loadPageWith('<h1><span>Hi</span></h1>')
    expect(mapping(page)).toEqual(['span:base.text', 'h1:base.container'])
  })

  it('maps a text-only button to base.button', async () => {
    const page = await loadPageWith('<button>Save</button>')
    expect(mapping(page)).toEqual(['base.button'])
  })

  it('does NOT map a button with element children to base.button — they would be dropped', async () => {
    // base.button is canHaveChildren:false, so this must become a container.
    const page = await loadPageWith('<button><span>Save</span></button>')
    expect(mapping(page)).toEqual(['span:base.text', 'button:base.container'])
  })

  it('does NOT map an icon-only button to base.button — it would render a phantom "Button" label', async () => {
    const page = await loadPageWith('<button className="close" />')
    expect(mapping(page)).toEqual(['button:base.container'])
  })

  it('keeps genuine leaves and container tags unconditionally', async () => {
    const page = await loadPageWith('<div><img src="/a.png" /><a href="/x">Go</a></div>')
    expect(mapping(page)).toEqual(['base.image', 'base.link', 'base.container'])
  })

  it('keeps base.link for an anchor that wraps children — it accepts them', async () => {
    const page = await loadPageWith('<a href="/x"><span>Go</span></a>')
    expect(mapping(page)).toEqual(['span:base.text', 'base.link'])
  })
})

describe('resolveModuleId — the real host tag survives the module default', () => {
  it('keeps an inline span inline instead of letting base.text default it to a block <p>', async () => {
    const page = await loadPageWith('<span>Hi</span>')
    expect(mapping(page)).toEqual(['span:base.text'])
  })

  it('keeps a heading tag on base.text', async () => {
    const page = await loadPageWith('<h1>Big</h1>')
    expect(mapping(page)).toEqual(['h1:base.text'])
  })

  it('omits the tag prop when the element already matches the module default', async () => {
    const page = await loadPageWith('<p>Hello</p>')
    expect(page.nodes[Object.keys(page.nodes).find((id) => page.nodes[id]!.moduleId === 'base.text')!]!.props.tag)
      .toBeUndefined()
  })

  it('keeps a text-only tag outside the base.text named list on base.text, through customTag (WB-3)', async () => {
    // Before P3-B this was `label:base.container` — a container has no text
    // prop, so "Name" was simply gone from the canvas.
    const page = await loadPageWith('<label>Name</label>')
    expect(mapping(page)).toEqual(['label:base.text'])
    const label = Object.values(page.nodes).find((n) => n.moduleId === 'base.text')!
    expect(label.props).toMatchObject({ tag: 'custom', customTag: 'label', text: 'Name' })
  })
})

describe('resolveModuleId — WB-3 text inside a container tag is a text node', () => {
  it('maps every text-only element whose text is its content to base.text on its own tag', async () => {
    const page = await loadPageWith(
      '<main><div>d</div><section>s</section><li>l</li><td>t</td><dt>term</dt><figcaption>f</figcaption><code>c</code><b>b</b></main>',
    )
    expect(mapping(page)).toEqual([
      'div:base.text',
      'section:base.text',
      'li:base.text',
      'td:base.text',
      'dt:base.text',
      'figcaption:base.text',
      'code:base.text',
      'b:base.text',
      'main:base.container',
    ])
  })

  it('keeps a text-only element whose text is NOT its visible content a container', async () => {
    // A form value, an option label inside a select, document metadata and a
    // tag no text module may emit: rendering their text as content would show
    // something the app never does.
    const page = await loadPageWith(
      '<form><textarea>draft</textarea><select><option>one</option></select><title>t</title><style>{"a{}"}</style></form>',
    )
    expect(mapping(page)).toEqual([
      'textarea:base.container',
      'option:base.container',
      'select:base.container',
      'title:base.container',
      'style:base.container',
      'form:base.container',
    ])
  })
})

// ---------------------------------------------------------------------------
// pkg-02 / WS-3.3 — package components get `pkg.<sanitized-package>.<Name>`
// ---------------------------------------------------------------------------

/** Writes a one-page workspace with arbitrary imports (a real npm package need not be installed — see below). */
async function loadPageWithImports(imports: string, jsx: string): Promise<Page> {
  const full = path.join(tmpDir, 'pages', 'Home.jsx')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(
    full,
    [imports, 'export default function Home() {', `  return (${jsx})`, '}', ''].join('\n'),
    'utf8',
  )
  const { pages } = await loadStudioPages(tmpDir)
  return pages[0]!
}

describe('resolveModuleId — WS-3.3 package components', () => {
  it('routes a component from a bare-specifier import to pkg.<sanitized>.<Name>', async () => {
    // No real `node_modules/some-design-system` on disk — ts-morph simply
    // can't resolve the specifier to a file, which `resolveComponentSources`
    // already treats as `kind: 'package'` (see `classifyImport`'s
    // `resolved` branch). Real-corpus behaviour is identical: the workspace
    // DOES have the package installed, but resolution to a real file still
    // means "not inside the workspace root", the same classification.
    const page = await loadPageWithImports(
      "import { Button } from 'some-design-system'",
      '<Button label="Save" />',
    )
    expect(mapping(page)).toEqual(['pkg.some_design_system.Button'])
  })

  /**
   * DS-3 — the carve-out is GONE. There is no design-system npm any more, so
   * an unmigrated project that still imports it gets exactly what every other
   * package gets: a `pkg.*` id, the Tier-0 package placeholder, and (from
   * DS-2) a migration banner. Rendering Studio's own components for a
   * dependency that no longer exists would hide the fact that the project's
   * own code does not build.
   */
  it('routes the RETIRED design-system npm to pkg.* like any other package', async () => {
    const page = await loadPageWithImports(
      "import { Card } from '@alm-design/design-system'",
      '<Card />',
    )
    expect(mapping(page)).toEqual(['pkg._alm_design_design_system.Card'])
  })

  /**
   * The built-in design system, reached the way a migrated project reaches
   * it: a relative import of its own `design-system/` folder. The folder is a
   * BLACK BOX — `Card` is not inlined into the page even though its source
   * sits right there inside the workspace — and the id is minted from the
   * EXPORT name, so an alias still lands on the right module.
   */
  it('routes the project design-system folder to alm.<ExportName>, aliased or not', async () => {
    const dsDir = path.join(tmpDir, 'design-system')
    fs.mkdirSync(path.join(dsDir, 'components'), { recursive: true })
    fs.writeFileSync(
      path.join(dsDir, 'components', 'Card.jsx'),
      'export function Card({ title }) {\n  return <section className="card"><h2>{title}</h2></section>\n}\n',
      'utf8',
    )
    fs.writeFileSync(path.join(dsDir, 'index.js'), "export { Card } from './components/Card'\n", 'utf8')

    const page = await loadPageWithImports(
      "import { Card as PlanCard } from '../design-system'",
      '<PlanCard title="Pro" />',
    )
    expect(mapping(page)).toEqual(['alm.Card'])
    // Black box: the component's own `<section>`/`<h2>` never reached the page.
    expect(Object.values(page.nodes).some((n) => n.moduleId === 'base.text')).toBe(false)
  })

  it('keeps an unclassified component (no import, no same-file declaration) on alm.<Name>', async () => {
    // `Mystery` isn't declared anywhere in this file, so `resolveComponentSources`
    // can't classify it as local OR package (no import, no same-file
    // declaration) — it's simply omitted from `componentSources`, which
    // `resolveModuleId` treats the same as "not a package": alm.<Name>, the
    // honest "nothing this pipeline can do about it" outcome.
    const page = await loadPageWithImports('', '<div><Mystery/></div>')
    expect(mapping(page)).toEqual(['alm.Mystery', 'base.container'])
  })
})

// ---------------------------------------------------------------------------
// pkg-02 / WS-3.4 — a component prop's JSX value materializes as a real slot node
// ---------------------------------------------------------------------------

describe('captureSlotProps — WS-3.4 slot materialization', () => {
  it('captures a JSX-valued component prop as a real child node, referenced by a sentinel', async () => {
    const page = await loadPageWithImports(
      "import { Cell, Icon } from 'some-design-system'",
      '<Cell icon={<Icon name="home" />} />',
    )
    const cell = Object.values(page.nodes).find((n) => n.moduleId === 'pkg.some_design_system.Cell')
    expect(cell).toBeDefined()
    const iconProp = cell!.props.icon
    expect(typeof iconProp).toBe('string')
    expect(iconProp as string).toStartWith('studio-slot:')

    const slotNodeId = (iconProp as string).slice('studio-slot:'.length)
    const slotNode = page.nodes[slotNodeId]
    expect(slotNode).toBeDefined()
    expect(slotNode!.moduleId).toBe('pkg.some_design_system.Icon')
    expect(slotNode!.props.name).toBe('home')
    // Structurally locked — it can't be dragged out of the slot — but its
    // OWN props stay ordinary/editable (not in codeProps).
    expect(slotNode!.locked).toBe(true)
    expect(slotNode!.codeProps ?? []).not.toContain('name')
    // Not a normal DOM child of Cell — only reachable via the sentinel.
    expect(cell!.children).not.toContain(slotNodeId)
  })

  it('captures more than one slot prop on the same component', async () => {
    const page = await loadPageWithImports(
      "import { Cell, Icon, Badge } from 'some-design-system'",
      '<Cell icon={<Icon name="home" />} trailing={<Badge label="new" />} />',
    )
    const cell = Object.values(page.nodes).find((n) => n.moduleId === 'pkg.some_design_system.Cell')!
    expect(typeof cell.props.icon).toBe('string')
    expect(typeof cell.props.trailing).toBe('string')
    expect(cell.props.icon).not.toBe(cell.props.trailing)
  })
})
