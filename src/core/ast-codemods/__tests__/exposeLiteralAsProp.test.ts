/**
 * exposeLiteralAsProp — P5-C (DET-7), "Expose as prop": a literal inside a
 * component becomes an optional prop whose default IS that literal, so every
 * other call site renders byte-identical, and (with a `value`) this one call
 * site passes its own.
 *
 * Every refusal asserts that EVERY file in the workspace is byte-identical.
 * The "generic shape" case (a `.jsx` arrow component, named export, no types,
 * a `...rest`) shares nothing with the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { exposeLiteralAsProp, type ExposeLiteralAsPropParams, type ExposeLiteralRefusalReason, type ExposeTarget } from '../exposeLiteralAsProp'
import { locateTag } from './fixtureLocation'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expose-literal-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(rel: string, text: string): string {
  const full = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
  return full
}

const read = (rel: string) => fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf8')

function snapshot(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.set(full, fs.readFileSync(full, 'latin1'))
    }
  }
  walk(tmpDir)
  return out
}

/** Exposes `target` on the `elementTag` inside `componentRel`, at the `occurrence`-th `<callTag` of `pageRel`. */
function expose(input: {
  pageRel: string
  callTag: string
  occurrence?: number
  componentRel: string
  elementTag: string
  target: ExposeTarget
  propName: string
  value?: ExposeLiteralAsPropParams['value']
}) {
  const call = locateTag(read(input.pageRel), input.callTag, input.occurrence ?? 1)
  const element = locateTag(read(input.componentRel), input.elementTag)
  return exposeLiteralAsProp({
    callSiteFile: path.join(tmpDir, ...input.pageRel.split('/')),
    callSiteLine: call.line,
    callSiteCol: call.col,
    elementFile: path.join(tmpDir, ...input.componentRel.split('/')),
    line: element.line,
    col: element.col,
    workspaceRoot: tmpDir,
    target: input.target,
    propName: input.propName,
    ...(input.value !== undefined ? { value: input.value } : {}),
  })
}

function expectRefused(input: Parameters<typeof expose>[0], reason: ExposeLiteralRefusalReason): string {
  const before = snapshot()
  const result = expose(input)
  if (result.ok) throw new Error(`expected ${reason}, got a success`)
  expect(result.refusal.reason).toBe(reason)
  expect(snapshot()).toEqual(before)
  return result.refusal.message
}

const CARD = [
  'export function Card({ title }: { title: string }) {',
  '  return (',
  '    <article className="card">',
  '      <h2>',
  '        Current text',
  '      </h2>',
  '      <p>{title}</p>',
  '    </article>',
  '  )',
  '}',
  '',
].join('\n')

const HOME = [
  "import { Card } from '../components/Card'",
  'export default function Home() {',
  '  return (',
  '    <main>',
  '      <Card title="One" />',
  '      <Card title="Two" />',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

const ABOUT = [
  "import { Card } from '../components/Card'",
  'export default function About() {',
  '  return <Card title="Three" />',
  '}',
  '',
].join('\n')

describe('expose a literal as a prop — every other instance renders byte-identical', () => {
  it('text: the default is the old text, only this call site passes the new one, and the type gains an optional member', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    write('pages/About.tsx', ABOUT)
    const result = expose({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading', value: 'New text' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result).toEqual({ ok: true, propName: 'heading', callSites: 3 })

    const card = read('components/Card.tsx')
    expect(card).toContain("export function Card({ title, heading = 'Current text' }: { title: string; heading?: string }) {")
    expect(card).toContain('      <h2>\n        {heading}\n      </h2>')
    expect(read('pages/Home.tsx')).toBe(HOME.replace('<Card title="One" />', '<Card title="One" heading="New text" />'))
    // The other instances: not one byte changed, and they read the default.
    expect(read('pages/About.tsx')).toBe(ABOUT)
  })

  it('with no value, only the component changes — every call site, this one included, renders the default', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    const result = expose({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading' })
    expect(result.ok).toBe(true)
    expect(read('pages/Home.tsx')).toBe(HOME)
  })

  it('an attribute and an inline style value', () => {
    write('components/Logo.tsx', [
      'interface LogoProps { size: number }',
      'export function Logo({ size }: LogoProps) {',
      '  return <img src="/logo.png" alt="Company logo" style={{ width: size, opacity: 0.8 }} />',
      '}',
      '',
    ].join('\n'))
    const page = "import { Logo } from '../components/Logo'\nexport default function Home() {\n  return <Logo size={40} />\n}\n"
    write('pages/Home.tsx', page)
    const alt = expose({ pageRel: 'pages/Home.tsx', callTag: 'Logo', componentRel: 'components/Logo.tsx', elementTag: 'img', target: { kind: 'attribute', name: 'alt' }, propName: 'label', value: 'Acme' })
    if (!alt.ok) throw new Error(alt.refusal.message)
    const opacity = expose({ pageRel: 'pages/Home.tsx', callTag: 'Logo', componentRel: 'components/Logo.tsx', elementTag: 'img', target: { kind: 'style', property: 'opacity' }, propName: 'fade', value: 0.5 })
    if (!opacity.ok) throw new Error(opacity.refusal.message)

    const logo = read('components/Logo.tsx')
    expect(logo).toContain('interface LogoProps { size: number; label?: string; fade?: number }')
    expect(logo).toContain("export function Logo({ size, label = 'Company logo', fade = 0.8 }: LogoProps) {")
    expect(logo).toContain('alt={label} style={{ width: size, opacity: fade }}')
    expect(read('pages/Home.tsx')).toContain('<Logo size={40} label="Acme" fade={0.5} />')
  })

  it('names the prop so nothing already means it: a call site passing `heading` through `...rest` keeps its meaning', () => {
    write('components/Card.tsx', [
      'export function Card({ title, ...rest }: { title: string; [key: string]: unknown }) {',
      '  return (',
      '    <article {...rest}>',
      '      <h2>Current text</h2>',
      '      <p>{title}</p>',
      '    </article>',
      '  )',
      '}',
      '',
    ].join('\n'))
    write('pages/Home.tsx', HOME)
    write('pages/About.tsx', ABOUT.replace('<Card title="Three" />', '<Card title="Three" heading="data-attr" />'))
    const result = expose({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading', value: 'New' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.propName).toBe('heading2')
    const card = read('components/Card.tsx')
    expect(card).toContain("{ title, heading2 = 'Current text', ...rest }")
    expect(card).toContain('<h2>{heading2}</h2>')
    expect(read('pages/Home.tsx')).toContain('<Card title="One" heading2="New" />')
  })
})

describe('expose — generic shape: a .jsx arrow component, named export, no types (shares nothing with the eSIM corpus)', () => {
  it('adds the binding to an untyped pattern and writes the call site', () => {
    write('ui/Banner.jsx', "export const Banner = ({ tone }) => (\n  <div className={tone}>\n    <strong>Heads up!</strong>\n  </div>\n)\n")
    const screen = "import { Banner } from './ui/Banner'\nexport const Screen = () => <Banner tone=\"warn\" />\n"
    write('Screen.jsx', screen)
    const result = expose({ pageRel: 'Screen.jsx', callTag: 'Banner', componentRel: 'ui/Banner.jsx', elementTag: 'strong', target: { kind: 'text' }, propName: 'message', value: 'Saved' })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(read('ui/Banner.jsx')).toBe("export const Banner = ({ tone, message = 'Heads up!' }) => (\n  <div className={tone}>\n    <strong>{message}</strong>\n  </div>\n)\n")
    expect(read('Screen.jsx')).toBe(screen.replace('<Banner tone="warn" />', '<Banner tone="warn" message="Saved" />'))
  })
})

describe('expose — refusals leave every file byte-identical', () => {
  it('refuses `not-a-literal` for text that is already a binding — it is never baked', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'p', target: { kind: 'text' }, propName: 'body', value: 'x' }, 'not-a-literal')
  })

  it('refuses `unsupported-params` for an undestructured props parameter', () => {
    write('components/Card.tsx', 'export function Card(props: { title: string }) {\n  return <h2>Current text {props.title}</h2>\n}\n')
    write('pages/Home.tsx', HOME)
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading' }, 'unsupported-params')
  })

  it('refuses `call-site-spread` when any call site spreads an object into the component', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    write('pages/About.tsx', "import { Card } from '../components/Card'\nconst props = { title: 'x' }\nexport default function About() {\n  return <Card {...props} />\n}\n")
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading', value: 'y' }, 'call-site-spread')
  })

  it('refuses `unsupported-props-type` for a component typed through its variable (FC<Props>)', () => {
    write('components/Card.tsx', "import type { FC } from 'react'\ntype Props = { title: string }\nexport const Card: FC<Props> = ({ title }) => <h2>Current text</h2>\n")
    write('pages/Home.tsx', HOME)
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Card.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading' }, 'unsupported-props-type')
  })

  it('refuses `maps-over-props` for a literal rendered once per item of a prop', () => {
    write('components/List.tsx', 'export function List({ items }: { items: string[] }) {\n  return <ul>{items.map((item) => <li key={item}>Item</li>)}</ul>\n}\n')
    write('pages/Home.tsx', "import { List } from '../components/List'\nexport default function Home() {\n  return <List items={['a']} />\n}\n")
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'List', componentRel: 'components/List.tsx', elementTag: 'li', target: { kind: 'text' }, propName: 'label' }, 'maps-over-props')
  })

  it('refuses `not-in-component` for an element of another file', () => {
    write('components/Card.tsx', CARD)
    write('pages/Home.tsx', HOME)
    write('components/Other.tsx', 'export function Other() {\n  return <h2>Elsewhere</h2>\n}\n')
    expectRefused({ pageRel: 'pages/Home.tsx', callTag: 'Card', componentRel: 'components/Other.tsx', elementTag: 'h2', target: { kind: 'text' }, propName: 'heading' }, 'not-in-component')
  })
})
