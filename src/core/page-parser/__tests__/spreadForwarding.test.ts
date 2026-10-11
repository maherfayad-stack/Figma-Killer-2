/**
 * G-2b - a component that passes its own props to another with a spread
 * (`<Inner {...props} />`, `{...rest}`): the inner component's elements read
 * what the PAGE passed, in JSX order, and a value that arrives that way is the
 * page's call site to write.
 *
 * The fixture is a plain TypeScript notification app (a `Toast` that spreads
 * onto a `Banner`) that shares nothing with the eSIM corpus or the pricing-tier
 * project the server tests use. The assertions are about what is NOT claimed as
 * much as what is: a spread the parser cannot read as "my props" merges
 * nothing, a name the forwarder takes itself is not forwarded, and an attribute
 * after the spread outranks it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPageEvalBudget, createWorkspaceProject, inlineLocalComponents, parsePageFile, resolveComponentSources, type ParsedNode, type StaticEvalOptions } from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-forwarding-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, lines: string[]): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, lines.join('\n'), 'utf8')
}

function load(pageRel: string): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const options: StaticEvalOptions = { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
  const parsed = parsePageFile(file, tmpDir, project, options)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return Object.values(inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: options }).nodes)
}

const BANNER = [
  'interface BannerProps { message?: string; tone?: string; className?: string }',
  "export function Banner({ message = 'Saved', tone = 'calm', className }: BannerProps) {",
  '  return <p className={`banner ${className ?? ""}`} title={tone}>{message}</p>',
  '}',
  '',
]

const inlinedBanner = (nodes: ParsedNode[]): ParsedNode[] => nodes.filter((node) => node.fromComponent === 'Banner' && node.name === 'p').sort((a, b) => a.id.localeCompare(b.id))

describe('an unfiltered spread hands the page\'s props to the inner component', () => {
  beforeEach(() => {
    write('src/Banner.tsx', BANNER)
    write('src/Toast.tsx', ["import { Banner } from './Banner'", 'export function Toast(props: { message?: string; tone?: string; className?: string }) {', '  return <Banner {...props} />', '}', ''])
    write('src/Page.tsx', [
      "import { Toast } from './Toast'",
      'export default function Page() {',
      '  return (',
      '    <main>',
      '      <Toast />',
      '      <Toast message="Deleted" className="loud" />',
      '    </main>',
      '  )',
      '}',
      '',
    ])
  })

  it('the inner text and class are the page\'s, and a literal the page passed keeps its origin at the page', () => {
    const [plain, passing] = inlinedBanner(load('src/Page.tsx'))
    expect(plain!.text).toBe('Saved')
    expect(passing!.text).toBe('Deleted')
    expect(passing!.props.className).toBe('banner loud')
    // The literal lives on the page's call site: that is where the text is written, never in Banner or Toast.
    expect(passing!.textOrigin?.rel).toBe('src/Page.tsx')
  })

  it('a value the page did not pass is the inner default, and a feed whose prop is the page\'s to set', () => {
    const [plain] = inlinedBanner(load('src/Page.tsx'))
    expect(plain!.propFeeds).toEqual({ text: 'message', title: 'tone' })
  })

  it('the forwarding call site carries the merged values as code, with the page\'s origins', () => {
    const nodes = load('src/Page.tsx')
    const instances = nodes.filter((node) => node.instanceOf?.componentName === 'Banner').sort((a, b) => a.id.localeCompare(b.id))
    const passing = instances[1]!
    expect(passing.spreadForwarded).toBe(true)
    expect(passing.props.message).toBe('Deleted')
    expect(passing.props.className).toBe('loud')
    expect(passing.codeProps).toEqual(expect.arrayContaining(['message', 'className']))
    expect(passing.literalPropOrigins?.message?.rel).toBe('src/Page.tsx')
  })
})

describe('what the spread does not hand on', () => {
  it('a name the forwarder destructures itself is not in its rest', () => {
    write('src/Banner.tsx', BANNER)
    write('src/Toast.tsx', ["import { Banner } from './Banner'", 'export function Toast({ tone, ...rest }: { message?: string; tone?: string }) {', '  return <Banner {...rest} />', '}', ''])
    write('src/Page.tsx', ["import { Toast } from './Toast'", 'export default function Page() {', '  return <Toast message="Hi" tone="loud" />', '}', ''])
    const [banner] = inlinedBanner(load('src/Page.tsx'))
    expect(banner!.text).toBe('Hi')
    // `tone` stays the Banner default: the forwarder took it.
    expect(banner!.props.title).toBe('calm')
  })

  it('an attribute after the spread outranks it, one before it loses to it', () => {
    write('src/Banner.tsx', BANNER)
    write('src/Toast.tsx', [
      "import { Banner } from './Banner'",
      'export function Toast(props: { message?: string; tone?: string }) {',
      '  return <Banner message="Fixed" {...props} tone="always" />',
      '}',
      '',
    ])
    write('src/Page.tsx', ["import { Toast } from './Toast'", 'export default function Page() {', '  return <Toast message="Typed" tone="ignored" />', '}', ''])
    const [banner] = inlinedBanner(load('src/Page.tsx'))
    expect(banner!.text).toBe('Typed')
    expect(banner!.props.title).toBe('always')
  })

  it('a spread of anything else merges nothing and the inner component reads its defaults', () => {
    write('src/Banner.tsx', BANNER)
    write('src/Toast.tsx', [
      "import { Banner } from './Banner'",
      'const strip = (props: { message?: string }) => props',
      'export function Toast(props: { message?: string }) {',
      '  return <Banner {...strip(props)} />',
      '}',
      '',
    ])
    write('src/Page.tsx', ["import { Toast } from './Toast'", 'export default function Page() {', '  return <Toast message="Typed" />', '}', ''])
    const nodes = load('src/Page.tsx')
    const [banner] = inlinedBanner(nodes)
    expect(banner!.text).not.toBe('Typed')
    expect(nodes.filter((node) => node.instanceOf?.componentName === 'Banner').every((node) => node.spreadForwarded === undefined)).toBe(true)
  })
})
