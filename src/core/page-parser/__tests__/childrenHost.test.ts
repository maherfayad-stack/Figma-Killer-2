/**
 * OD-22 - the parser names the one element that renders a component's
 * `{children}`, because that element is where a drop into an instance can be
 * written at the call site without detaching it.
 *
 * It names it only when it can name exactly one plain place:
 *   - one `{children}` in a plain element: named;
 *   - none (the component ignores children, or takes no parameters at all): not;
 *   - two: not (a drop would have two places to land);
 *   - inside a branch: not (the element may not be there);
 *   - inside another component's call site: not (the place is that component's).
 *
 * The fixture is a kitchen-timer app: nothing in it is the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
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
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'children-host-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** The instance node of the only `<Tag>` call site on `pages/Timers.tsx`. */
function instanceOf(component: string, tag: string): ParsedNode {
  write('components/' + tag + '.tsx', component)
  write(
    'pages/Timers.tsx',
    [`import { ${tag} } from '../components/${tag}'`, 'export default function Timers() {', `  return <main><${tag}><b>x</b></${tag}></main>`, '}', ''].join('\n'),
  )
  const file = path.join(tmpDir, 'pages', 'Timers.tsx')
  const project = createWorkspaceProject(tmpDir)
  const opts = { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  const nodes = Object.values(inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: opts }).nodes)
  const instance = nodes.find((node) => node.instanceOf !== undefined)
  if (!instance) throw new Error('no instance node')
  return instance
}

describe('ParsedNode.instanceOf.childrenHost', () => {
  it('names the element that renders {children}, as the inlined id one call site deep', () => {
    const instance = instanceOf(
      ['export function Frame({ children }: { children?: React.ReactNode }) {', '  return <section><h2>Timer</h2><div className="body">{children}</div></section>', '}', ''].join('\n'),
      'Frame',
    )
    expect(instance.instanceOf!.childrenHost).toBe(`${instance.id}~components/Frame.tsx:2:34`)
  })

  it('names nothing for a component that ignores its children', () => {
    const instance = instanceOf(['export function Ring({ label }: { label?: string }) {', '  return <div className="ring">{label}</div>', '}', ''].join('\n'), 'Ring')
    expect(instance.instanceOf!.childrenHost).toBeUndefined()
  })

  it('names nothing for a component with no parameters', () => {
    const instance = instanceOf(['export function Dial() {', '  return <div className="dial" />', '}', ''].join('\n'), 'Dial')
    expect(instance.instanceOf!.childrenHost).toBeUndefined()
  })

  it('names nothing when {children} is rendered in two places', () => {
    const instance = instanceOf(
      ['export function Twin({ children }: { children?: React.ReactNode }) {', '  return <div><header>{children}</header><footer>{children}</footer></div>', '}', ''].join('\n'),
      'Twin',
    )
    expect(instance.instanceOf!.childrenHost).toBeUndefined()
  })

  it('names nothing when the element holding {children} is only there on a branch', () => {
    const instance = instanceOf(
      [
        'export function Drawer({ open, children }: { open?: boolean; children?: React.ReactNode }) {',
        '  return <aside>{open ? <div className="inner">{children}</div> : null}</aside>',
        '}',
        '',
      ].join('\n'),
      'Drawer',
    )
    expect(instance.instanceOf!.childrenHost).toBeUndefined()
  })

  it('names nothing when {children} sits inside another component, whose own markup decides where it goes', () => {
    write('components/Panel.tsx', ['export function Panel({ children }: { children?: React.ReactNode }) {', '  return <div className="panel">{children}</div>', '}', ''].join('\n'))
    const instance = instanceOf(
      ["import { Panel } from './Panel'", 'export function Card({ children }: { children?: React.ReactNode }) {', '  return <Panel>{children}</Panel>', '}', ''].join('\n'),
      'Card',
    )
    expect(instance.instanceOf!.childrenHost).toBeUndefined()
  })
})
