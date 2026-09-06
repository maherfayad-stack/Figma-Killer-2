/**
 * W4-4 Phase A — static extraction of styled-components/emotion templates.
 *
 * Two fixtures, deliberately: a styled-components repo and an emotion repo,
 * written in different idioms (default vs named export, `.tsx` page with a
 * separate component file vs one file, a theme module vs inline consts). Same
 * discipline `genericRepoShapes.test.ts` states — a suite grown from one repo's
 * habits encodes those habits — and CSS-in-JS is exactly the area where two
 * libraries' idioms diverge.
 *
 * **The refusals are tested as hard as the successes.** A parser change that
 * silently starts extracting where it used to drop is the regression that
 * matters here: a declaration whose value the evaluator cannot read must NOT
 * reach the canvas wearing a guessed value, and a template must not lose its
 * other twenty declarations because of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkCanonicalJsx,
  createPageEvalBudget,
  createWorkspaceProject,
  cssInJsStylesheet,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type CssInJsTemplate,
  type ParsedNode,
  type ParsedPage,
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-in-js-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function evalOptions(): StaticEvalOptions {
  return { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
}

/** Parses + inlines exactly like `loadStudioPages` does for one page. */
function load(pageRel: string): ParsedPage {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const opts = evalOptions()
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: opts })
}

const templateFor = (page: ParsedPage, componentName: string): CssInJsTemplate | undefined =>
  page.cssInJs?.templates.find((t) => t.componentName === componentName)

const nodeNamed = (page: ParsedPage, name: string): ParsedNode | undefined =>
  Object.values(page.nodes).find((n) => n.name === name)

/** The class names a node would contribute to `classIds`, in order. */
const classesOf = (node: ParsedNode | undefined): string[] =>
  typeof node?.props.className === 'string' ? node.props.className.split(' ') : []

// ---------------------------------------------------------------------------
// Fixture 1 — a styled-components repo
// ---------------------------------------------------------------------------

describe('a styled-components repo', () => {
  beforeEach(() => {
    write(
      'package.json',
      JSON.stringify({ name: 'sc-app', dependencies: { react: '18', 'styled-components': '6' } }),
    )
    write(
      'src/theme/tokens.ts',
      [
        "export const tokens = {",
        "  colors: { primary: '#3355ff', surface: '#ffffff' },",
        "  space: { md: '12px' },",
        '}',
      ].join('\n'),
    )
    write(
      'src/screens/Home.tsx',
      [
        "import styled, { css } from 'styled-components'",
        "import { tokens } from '../theme/tokens'",
        '',
        'const RADIUS = 8',
        '',
        'const Card = styled.div`',
        '  display: flex;',
        '  padding: ${tokens.space.md};',
        '  border-radius: ${RADIUS}px;',
        '',
        '  &:hover {',
        '    background: ${tokens.colors.primary};',
        '  }',
        '',
        '  & > * + * {',
        '    margin-left: 4px;',
        '  }',
        '',
        '  @media (max-width: 600px) {',
        '    padding: 4px;',
        '    .inner {',
        '      gap: 2px;',
        '    }',
        '  }',
        '`',
        '',
        'const Title = styled.h1`',
        '  font-size: 20px;',
        '  color: ${(p) => p.theme.colors.text};',
        '  font-weight: 600;',
        '`',
        '',
        'const Loud = styled(Title)`',
        '  text-transform: uppercase;',
        '`',
        '',
        "const Badge = styled.span.attrs({ role: 'status' })`",
        "  color: ${(p) => (p.active ? 'red' : 'blue')};",
        '  border: 1px solid;',
        '`',
        '',
        'const flexCenter = css`',
        '  align-items: center;',
        '  justify-content: center;',
        '`',
        '',
        'const Row = styled.div`',
        '  display: flex;',
        '  ${flexCenter}',
        '  gap: 4px;',
        '`',
        '',
        'export default function Home() {',
        '  return (',
        '    <Card className="page-card">',
        '      <Title>Hello</Title>',
        '      <Loud>Loud</Loud>',
        '      <Badge>New</Badge>',
        '      <Row><span>x</span></Row>',
        '    </Card>',
        '  )',
        '}',
      ].join('\n'),
    )
  })

  it('renders a styled component as its BASE TAG at the same source location — no wrapper element', () => {
    const page = load('src/screens/Home.tsx')
    const root = page.nodes[page.rootIds[0]!]!
    expect(root.kind).toBe('element')
    expect(root.name).toBe('div')
    // The id is still the `<Card>` tag's own line:col — the element IS written
    // there, so its writeback target is unchanged.
    expect(root.id).toMatch(/^src\/screens\/Home\.tsx:\d+:\d+$/)
    // No node named `Card` survives anywhere: a styled call site is not an
    // instance of anything, it is the element.
    expect(nodeNamed(page, 'Card')).toBeUndefined()
    expect(nodeNamed(page, 'h1')?.name).toBe('h1')
  })

  it('puts the synthetic class FIRST and keeps the call site\'s own className after it', () => {
    const page = load('src/screens/Home.tsx')
    const classes = classesOf(page.nodes[page.rootIds[0]!])
    expect(classes).toHaveLength(2)
    expect(classes[0]).toMatch(/^Card_sc__[0-9a-f]{6}$/)
    expect(classes[1]).toBe('page-card')
  })

  it('mints the same class name on every parse — ids must survive a reload', () => {
    const first = templateFor(load('src/screens/Home.tsx'), 'Card')!.className
    const second = templateFor(load('src/screens/Home.tsx'), 'Card')!.className
    expect(second).toBe(first)
  })

  it('extracts a template with no unreadable interpolation CLEAN, nesting and all', () => {
    const page = load('src/screens/Home.tsx')
    const card = templateFor(page, 'Card')!
    expect(card.status).toBe('clean')
    expect(card.findings).toEqual([])

    const css = card.css
    const cls = card.className
    // Tier A resolved the imported theme token and the local const.
    expect(css).toContain('padding: 12px')
    expect(css).toContain('border-radius: 8px')
    // `&` substitution, a combinator, and a nested @media all survive as real
    // selectors rather than being flattened onto the base rule.
    expect(css).toContain(`.${cls}:hover { background: #3355ff; }`)
    expect(css).toContain(`.${cls} > * + * { margin-left: 4px; }`)
    expect(css).toContain(`@media (max-width: 600px) { .${cls} { padding: 4px; } }`)
    expect(css).toContain(`@media (max-width: 600px) { .${cls} .inner { gap: 2px; } }`)
  })

  it('drops ONLY the declaration whose interpolation it cannot read, and says which', () => {
    const page = load('src/screens/Home.tsx')
    const title = templateFor(page, 'Title')!
    expect(title.status).toBe('partial')
    // `${(p) => p.theme.colors.text}` is a runtime theme read — dropped.
    expect(title.css).not.toContain('color:')
    // Its literal siblings are untouched. That is the whole rule.
    expect(title.css).toContain('font-size: 20px')
    expect(title.css).toContain('font-weight: 600')
    expect(title.declarationCount).toBe(2)
    const dropped = title.findings.filter((f) => f.kind === 'declaration-dropped')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.property).toBe('color')
    expect(dropped[0]!.expression).toContain('p.theme.colors.text')
  })

  it('chains styled(AlreadyStyled) onto the base tag, carrying BOTH classes base-first', () => {
    const page = load('src/screens/Home.tsx')
    const loud = templateFor(page, 'Loud')!
    expect(loud.base).toEqual({ kind: 'tag', tag: 'h1' })
    const node = Object.values(page.nodes).find((n) => classesOf(n).includes(loud.className))!
    expect(node.name).toBe('h1')
    expect(classesOf(node)).toEqual([templateFor(page, 'Title')!.className, loud.className])
  })

  it('takes a ternary\'s first branch when the condition is not decidable, and records the branch it did not take', () => {
    const page = load('src/screens/Home.tsx')
    const badge = templateFor(page, 'Badge')!
    expect(badge.status).toBe('partial')
    expect(badge.css).toContain('color: red')
    const guessed = badge.findings.filter((f) => f.kind === 'branch-guessed')
    expect(guessed).toHaveLength(1)
    expect(guessed[0]!.message).toContain("'blue'")
  })

  it('reports .attrs(…) rather than pretending it applied', () => {
    const badge = templateFor(load('src/screens/Home.tsx'), 'Badge')!
    expect(badge.findings.some((f) => f.kind === 'attrs-ignored')).toBe(true)
    // The template still extracts — `attrs` costs a finding, not the CSS.
    expect(badge.css).toContain('border: 1px solid')
  })

  it('splices a `css` mixin interpolated as a whole statement', () => {
    const row = templateFor(load('src/screens/Home.tsx'), 'Row')!
    expect(row.status).toBe('clean')
    expect(row.css).toContain('align-items: center')
    expect(row.css).toContain('justify-content: center')
    expect(row.css).toContain('gap: 4px')
  })

  it('produces one stylesheet with each class exactly once, however many times a file was parsed', () => {
    const page = load('src/screens/Home.tsx')
    const templates = page.cssInJs!.templates
    expect(cssInJsStylesheet([...templates, ...templates])).toBe(cssInJsStylesheet(templates))
  })

  it('reports per-template honesty through canonicalCheck, not one blanket line', () => {
    const page = load('src/screens/Home.tsx')
    const sourceText = fs.readFileSync(path.join(tmpDir, 'src', 'screens', 'Home.tsx'), 'utf8')
    const findings = checkCanonicalJsx({ page, sourceText }).filter((f) => f.ruleId === 'single-styling-mechanism')

    const headline = findings.find((f) => f.message.includes('template(s) statically extracted'))!
    expect(headline.message).toContain('6 template(s) statically extracted')
    expect(headline.message).toContain('4 clean, 2 partial, 0 unresolvable')
    // One line per non-clean template, at that template's OWN location.
    expect(findings).toHaveLength(3)
    expect(findings.some((f) => f.message.includes('`Title` extracted 2 declaration(s)'))).toBe(true)
    expect(findings.every((f) => f.tier === 'violation')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fixture 2 — an emotion repo, sharing nothing with fixture 1's idioms
// ---------------------------------------------------------------------------

describe('an emotion repo', () => {
  beforeEach(() => {
    write('package.json', JSON.stringify({ name: 'em-app', dependencies: { '@emotion/react': '11', '@emotion/styled': '11' } }))
    write(
      'app/ui/Panel.tsx',
      [
        "import styled from '@emotion/styled'",
        '',
        'export const Panel = styled.section`',
        '  border: 1px solid #eee;',
        '  padding: 16px;',
        '`',
      ].join('\n'),
    )
    write(
      'app/routes/settings.tsx',
      [
        "import { css } from '@emotion/react'",
        "import { Panel } from '../ui/Panel'",
        '',
        'const heading = css`',
        '  font-size: 28px;',
        '  letter-spacing: -0.02em;',
        '`',
        '',
        'export const Settings = () => (',
        '  <Panel>',
        '    <h2 css={heading}>Settings</h2>',
        '  </Panel>',
        ')',
        '',
        'export default Settings',
      ].join('\n'),
    )
  })

  it('attaches an emotion `css` const to the element that names it, and drops the css prop itself', () => {
    const page = load('app/routes/settings.tsx')
    const heading = templateFor(page, 'heading')!
    expect(heading.base).toEqual({ kind: 'standalone' })
    const h2 = nodeNamed(page, 'h2')!
    expect(classesOf(h2)).toEqual([heading.className])
    // `css` is compiled away by emotion's babel plugin — it is never a DOM
    // attribute, so neither a value nor a read-only trace belongs on the node.
    expect(h2.props.css).toBeUndefined()
    expect(h2.codeProps ?? []).not.toContain('css')
  })

  it('splices a `css` mixin declared in ANOTHER file', () => {
    write('app/ui/mixins.ts', ["import { css } from '@emotion/react'", '', 'export const boxed = css`', '  border-radius: 6px;', '  overflow: hidden;', '`'].join('\n'))
    write(
      'app/routes/boxed.tsx',
      [
        "import styled from '@emotion/styled'",
        "import { boxed } from '../ui/mixins'",
        '',
        'const Frame = styled.div`',
        '  ${boxed}',
        '  padding: 8px;',
        '`',
        '',
        'export default function Boxed() {',
        '  return <Frame>x</Frame>',
        '}',
      ].join('\n'),
    )
    const frame = templateFor(load('app/routes/boxed.tsx'), 'Frame')!
    expect(frame.status).toBe('clean')
    expect(frame.css).toContain('border-radius: 6px')
    expect(frame.css).toContain('overflow: hidden')
    expect(frame.css).toContain('padding: 8px')
  })

  it('merges a LOCAL COMPONENT file\'s own templates into the page that inlines it', () => {
    const page = load('app/routes/settings.tsx')
    // `Panel` is declared in another file entirely; its class must still reach
    // the registry, or the inlined `<section>` renders unstyled.
    const panel = templateFor(page, 'Panel')!
    expect(panel.loc.file).toBe('app/ui/Panel.tsx')
    expect(panel.css).toContain('padding: 16px')
    expect(nodeNamed(page, 'section')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Refusals — the half a regression would quietly delete
// ---------------------------------------------------------------------------

describe('what it refuses', () => {
  beforeEach(() => {
    write('package.json', JSON.stringify({ name: 'refusals', dependencies: { 'styled-components': '6' } }))
  })

  it('costs a project that uses no CSS-in-JS nothing at all', () => {
    write(
      'src/screens/Plain.tsx',
      ["import './Plain.css'", 'export default function Plain() {', '  return <div className="plain">hi</div>', '}'].join('\n'),
    )
    const page = load('src/screens/Plain.tsx')
    expect(page.cssInJs).toBeUndefined()
    expect(classesOf(page.nodes[page.rootIds[0]!])).toEqual(['plain'])
  })

  it('leaves styled(ImportedComponent) as that component, class applied, and says the element is decided elsewhere', () => {
    write('src/ui/Button.tsx', 'export const Button = (props) => <button {...props} />')
    write(
      'src/screens/Wrap.tsx',
      [
        "import styled from 'styled-components'",
        "import { Button } from '../ui/Button'",
        '',
        'const Primary = styled(Button)`',
        '  background: rebeccapurple;',
        '`',
        '',
        'export default function Wrap() {',
        '  return <Primary>Go</Primary>',
        '}',
      ].join('\n'),
    )
    const page = load('src/screens/Wrap.tsx')
    const primary = templateFor(page, 'Primary')!
    expect(primary.base).toEqual({ kind: 'component', name: 'Button' })
    expect(primary.status).toBe('partial')
    expect(primary.findings.some((f) => f.kind === 'wraps-component')).toBe(true)
    // The CSS is real and registered — what is uncertain is which element wears it.
    expect(primary.css).toContain('background: rebeccapurple')
  })

  it('drops a whole nested rule whose SELECTOR it cannot read, keeping the rest', () => {
    write(
      'src/screens/Sel.tsx',
      [
        "import styled from 'styled-components'",
        '',
        'const Box = styled.div`',
        '  color: black;',
        '  ${(p) => p.selector} {',
        '    color: white;',
        '  }',
        '  border: 0;',
        '`',
        '',
        'export default function Sel() {',
        '  return <Box>x</Box>',
        '}',
      ].join('\n'),
    )
    const box = templateFor(load('src/screens/Sel.tsx'), 'Box')!
    expect(box.status).toBe('partial')
    expect(box.css).toContain('color: black')
    expect(box.css).toContain('border: 0')
    expect(box.css).not.toContain('color: white')
  })

  it('reports an unreadable spliced block without losing the declarations around it', () => {
    write(
      'src/screens/Mixin.tsx',
      [
        "import styled from 'styled-components'",
        "import { fancy } from './nowhere-static'",
        '',
        'const Box = styled.div`',
        '  display: block;',
        '  ${fancy(2)}',
        '  color: red;',
        '`',
        '',
        'export default function Mixin() {',
        '  return <Box>x</Box>',
        '}',
      ].join('\n'),
    )
    const box = templateFor(load('src/screens/Mixin.tsx'), 'Box')!
    expect(box.findings.some((f) => f.kind === 'block-dropped')).toBe(true)
    expect(box.css).toContain('display: block')
    expect(box.css).toContain('color: red')
  })

  it('never throws on a template whose body is not CSS at all', () => {
    write(
      'src/screens/Junk.tsx',
      [
        "import styled from 'styled-components'",
        '',
        'const Box = styled.div`',
        '  }}} not css at all {{{',
        '`',
        '',
        'export default function Junk() {',
        '  return <Box>x</Box>',
        '}',
      ].join('\n'),
    )
    expect(() => load('src/screens/Junk.tsx')).not.toThrow()
    const box = templateFor(load('src/screens/Junk.tsx'), 'Box')!
    expect(box.status).toBe('unresolvable')
    expect(box.css).toBe('')
    // An unresolvable template contributes no class to render, and the element
    // still renders as its base tag rather than an opaque box.
    expect(nodeNamed(load('src/screens/Junk.tsx'), 'div')).toBeDefined()
  })

  it('does not extract stitches — a different API shape, deliberately out of scope', () => {
    write(
      'src/screens/Stitch.tsx',
      [
        "import { styled } from '@stitches/react'",
        '',
        "const Box = styled('div', { color: 'red' })",
        '',
        'export default function Stitch() {',
        '  return <Box>x</Box>',
        '}',
      ].join('\n'),
    )
    const page = load('src/screens/Stitch.tsx')
    expect(page.cssInJs).toBeUndefined()
  })
})
