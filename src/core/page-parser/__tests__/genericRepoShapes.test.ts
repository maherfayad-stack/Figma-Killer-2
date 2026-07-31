/**
 * Studio import against a repo that shares NOTHING with the eSIM corpus.
 *
 * Every other test in this folder was written from a defect found on one real
 * repository, so the suite as a whole risks encoding that repo's habits: default
 * exports, `function` declarations, `.jsx`, a `src/screens` pages dir, an i18n
 * hook, `?raw` icons. A second repo written in deliberately different idioms is
 * what shows the pipeline reads *React*, not that one app.
 *
 * The fixture below is a plain TypeScript app: `.tsx`, arrow components assigned
 * to `const`, a mix of default and NAMED exports, a barrel `index.ts` between the
 * page and the component, a `components/` dir at the repo root, a props interface,
 * optional props with defaults, and data that arrives as a typed array of objects.
 *
 * Each test names the *shape* it covers, not the app — a failure here means some
 * repo's ordinary way of writing React does not import.
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
  type StaticEvalOptions,
} from '@core/page-parser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-repo-'))
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
function load(pageRel: string): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const opts = evalOptions()
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return Object.values(inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: opts }).nodes)
}

const texts = (nodes: ParsedNode[]): string[] =>
  nodes.map((n) => n.text).filter((t): t is string => t !== undefined)

describe('an ordinary TypeScript React repo', () => {
  beforeEach(() => {
    // A typed data module — the shape almost every real list comes from.
    write(
      'app/data/plans.ts',
      [
        'export interface Plan {',
        '  id: string',
        '  name: string',
        '  seats: number',
        '  monthly: number',
        '}',
        '',
        'export const PLANS: Plan[] = [',
        "  { id: 'starter', name: 'Starter', seats: 1, monthly: 9 },",
        "  { id: 'team', name: 'Team', seats: 5, monthly: 29 },",
        "  { id: 'scale', name: 'Scale', seats: 25, monthly: 99 },",
        ']',
        '',
        'export const money = (amount: number): string => `$${amount}/mo`',
        "export const seatLabel = (seats: number): string => `${seats} seat${seats === 1 ? '' : 's'}`",
        '',
      ].join('\n'),
    )

    // A NAMED-export arrow component with a props interface and a default.
    write(
      'app/components/PlanCard.tsx',
      [
        "import { money, seatLabel, type Plan } from '../data/plans'",
        '',
        'interface PlanCardProps {',
        '  plan: Plan',
        '  featured?: boolean',
        '}',
        '',
        "export const PlanCard = ({ plan, featured = false }: PlanCardProps) => (",
        '  <article className={featured ? "plan plan--featured" : "plan"}>',
        '    <h3 className="plan__name">{plan.name}</h3>',
        '    <p className="plan__seats">{seatLabel(plan.seats)}</p>',
        '    <p className="plan__price">{money(plan.monthly)}</p>',
        '  </article>',
        ')',
        '',
      ].join('\n'),
    )

    // A barrel between the page and the component — extremely common, and it
    // means the import specifier names a directory, not the component's file.
    write('app/components/index.ts', ["export { PlanCard } from './PlanCard'", ''].join('\n'))
  })

  it('inlines a named-export arrow component reached through a barrel', () => {
    write(
      'app/routes/Pricing.tsx',
      [
        "import { PlanCard } from '../components'",
        "import { PLANS } from '../data/plans'",
        '',
        'const Pricing = () => (',
        '  <main className="pricing">',
        '    <h1>Pricing</h1>',
        '    {PLANS.map((plan) => (',
        '      <PlanCard key={plan.id} plan={plan} featured={plan.id === "team"} />',
        '    ))}',
        '  </main>',
        ')',
        '',
        'export default Pricing',
        '',
      ].join('\n'),
    )

    const nodes = load('app/routes/Pricing.tsx')
    // Three rows, each with the component's own three elements — not one opaque
    // `<PlanCard>` box, and not a single un-expanded row.
    expect(nodes.filter((n) => n.name === 'article')).toHaveLength(3)
    expect(texts(nodes)).toEqual([
      'Pricing',
      'Starter', '1 seat', '$9/mo',
      'Team', '5 seats', '$29/mo',
      'Scale', '25 seats', '$99/mo',
    ])
  })

  it('WS-4.2 — each call site becomes its own "instance" node (named-export arrow, reached through a barrel)', () => {
    write(
      'app/routes/Pricing.tsx',
      [
        "import { PlanCard } from '../components'",
        "export const Pricing = () => (",
        '  <main>',
        '    <PlanCard plan={{ id: \'x\', name: \'Solo\', seats: 1, monthly: 5 }} featured />',
        '  </main>',
        ')',
        '',
      ].join('\n'),
    )

    const nodes = load('app/routes/Pricing.tsx')
    const instance = nodes.find((n) => n.instanceOf?.componentName === 'PlanCard')
    expect(instance).toBeDefined()
    expect(instance!.instanceOf?.source).toBe('local')
    expect(instance!.instanceOf?.sourceFile).toBe('app/components/PlanCard.tsx')
    // `featured` (a boolean-shorthand attribute) round-trips as a real call-site prop.
    expect(instance!.instanceOf?.callSiteProps.featured).toBe(true)
    // The instance itself contributes no element of its own — `article` is
    // its CHILD (not itself named "article"), reachable via `children`.
    expect(instance!.kind).toBe('component')
    const article = nodes.find((n) => n.name === 'article')
    expect(article).toBeDefined()
    expect(instance!.children).toContain(article!.id)
  })

  it('resolves a field read off a loop item passed through a component prop', () => {
    write(
      'app/routes/Pricing.tsx',
      [
        "import { PlanCard } from '../components'",
        "import { PLANS } from '../data/plans'",
        'const Pricing = () => <div>{PLANS.map((plan) => <PlanCard key={plan.id} plan={plan} />)}</div>',
        'export default Pricing',
        '',
      ].join('\n'),
    )

    // `plan` is a loop item, forwarded as an OBJECT prop, then read as
    // `{plan.name}` inside the component's own file. Three hops, no literals.
    expect(texts(load('app/routes/Pricing.tsx'))).toContain('Scale')
  })

  it('reads the component`s own default when the call site omits a prop', () => {
    write(
      'app/routes/One.tsx',
      [
        "import { PlanCard } from '../components'",
        "import { PLANS } from '../data/plans'",
        'const One = () => <PlanCard plan={PLANS[0]} />',
        'export default One',
        '',
      ].join('\n'),
    )

    // `featured = false` decides the className via a ternary the evaluator can
    // now settle, so the element keeps the class the source would render.
    const article = load('app/routes/One.tsx').find((n) => n.name === 'article')
    expect(article?.props.className).toBe('plan')
  })

  it('exports the page as `export default function` too', () => {
    write(
      'app/routes/Plain.tsx',
      [
        'export default function Plain() {',
        '  return <section><h2>Hello</h2></section>',
        '}',
        '',
      ].join('\n'),
    )

    expect(texts(load('app/routes/Plain.tsx'))).toEqual(['Hello'])
  })

  it('handles a fragment root', () => {
    write(
      'app/routes/Frag.tsx',
      [
        'const Frag = () => (',
        '  <>',
        '    <h1>One</h1>',
        '    <h1>Two</h1>',
        '  </>',
        ')',
        'export default Frag',
        '',
      ].join('\n'),
    )

    // A fragment is not a node; its children become the page roots.
    expect(texts(load('app/routes/Frag.tsx'))).toEqual(['One', 'Two'])
  })

  it('keeps a package component opaque while inlining the local one', () => {
    write(
      'app/routes/Mixed.tsx',
      [
        "import { Button } from '@acme/ui'",
        "import { PlanCard } from '../components'",
        "import { PLANS } from '../data/plans'",
        'const Mixed = () => (',
        '  <div>',
        '    <PlanCard plan={PLANS[1]} />',
        '    <Button label="Buy" />',
        '  </div>',
        ')',
        'export default Mixed',
        '',
      ].join('\n'),
    )

    const nodes = load('app/routes/Mixed.tsx')
    // The local component is expanded into real elements; the package one stays a
    // component node for its own module to render.
    expect(nodes.some((n) => n.name === 'article')).toBe(true)
    const button = nodes.find((n) => n.name === 'Button')
    expect(button?.kind).toBe('component')
    expect(button?.props.label).toBe('Buy')
  })

  it('captures a CSS-module className as the imported binding cannot be a literal', () => {
    write('app/routes/Styled.module.css', '.wrap { color: red }\n')
    write(
      'app/routes/Styled.tsx',
      [
        "import styles from './Styled.module.css'",
        'const Styled = () => <div className={styles.wrap}>Hi</div>',
        'export default Styled',
        '',
      ].join('\n'),
    )

    // A CSS-module class name is generated at build time and is genuinely not
    // knowable here. The element must still exist, with its text — silently
    // dropping the node would lose the content too.
    const div = load('app/routes/Styled.tsx').find((n) => n.name === 'div')
    expect(div).toBeDefined()
    expect(div?.text).toBe('Hi')
  })

  it('does not choke on hooks, handlers, or effects it cannot run', () => {
    write(
      'app/routes/Stateful.tsx',
      [
        "import { useEffect, useState } from 'react'",
        'const Stateful = () => {',
        '  const [count, setCount] = useState(0)',
        '  useEffect(() => { document.title = String(count) }, [count])',
        '  return (',
        '    <div>',
        '      <h1>Counter</h1>',
        '      <button type="button" onClick={() => setCount((c) => c + 1)}>Add one</button>',
        '    </div>',
        '  )',
        '}',
        'export default Stateful',
        '',
      ].join('\n'),
    )

    // Nothing is executed. The markup and its copy still arrive, and the handler
    // is simply not a prop the canvas carries.
    const nodes = load('app/routes/Stateful.tsx')
    expect(texts(nodes)).toEqual(['Counter', 'Add one'])
    expect(nodes.find((n) => n.name === 'button')?.props.onClick).toBeUndefined()
  })

  it('reads a useState(<literal>) initial value to decide a `&&` overlay, not stack it (parser-07)', () => {
    write(
      'app/routes/Overlay.tsx',
      [
        "import { useState } from 'react'",
        'interface OverlayProps {',
        '  title: string',
        '}',
        'const Overlay = ({ title }: OverlayProps) => {',
        '  const [showHelp, setShowHelp] = useState(false)',
        '  return (',
        '    <section>',
        '      <h2>{title}</h2>',
        '      {showHelp && <p className="help">Need a hand?</p>}',
        '    </section>',
        '  )',
        '}',
        'export default Overlay',
        '',
      ].join('\n'),
    )

    // `showHelp`'s initial value is a literal `false` right there in the
    // source, not hook state that has to run — so the FIRST PAINT the canvas
    // shows has the help panel hidden, not stacked on top of the heading.
    const nodes = load('app/routes/Overlay.tsx')
    expect(nodes.find((n) => n.name === 'p')).toBeUndefined()
    expect(nodes.find((n) => n.name === 'section')?.locked).toBe(false)
  })

  it('yields an empty page rather than throwing on a file it cannot parse', () => {
    write('app/routes/Broken.tsx', 'export default function Broken( { <<< \n')

    expect(() => load('app/routes/Broken.tsx')).not.toThrow()
    expect(load('app/routes/Broken.tsx')).toEqual([])
  })

  it('yields an empty page for a module that exports no component', () => {
    write('app/routes/Consts.tsx', "export const VERSION = '1.0.0'\n")

    expect(load('app/routes/Consts.tsx')).toEqual([])
  })
})
