/**
 * P3-C (WB-6) — text and props a component receives from its CALL SITE carry
 * the call site's literal as their `origin`, so an edit on the rendered copy
 * is written there: one honest target per instance.
 *
 * `<SectionHeading title="Weeknight dinners"/>` renders `<h2>{title}</h2>`.
 * The `{title}` in the component's file is NOT a writeback target — writing a
 * string there would delete the parameter binding for every instance — but the
 * call site's `"Weeknight dinners"` is an ordinary string literal, owned by this
 * instance alone. Before this, the inlined `<h2>` carried the text with
 * `codeText` and no `textOrigin`, so the copy most component-based apps are
 * made of was read-only.
 *
 * The refusals are pinned beside the successes, because a change that starts
 * writing where it used to refuse is the regression this module fears most:
 *
 *   - a component DEFAULT (`eyebrow = 'Featured'`) feeds every call site that
 *     omits the prop, so editing it would change N instances nobody asked
 *     about — no origin;
 *   - a literal attribute on a call site INSIDE a `.map` row renders every row
 *     from one piece of JSX — no origin;
 *   - a COMPUTED value (`'Slow ' + 'cooked'`) has no single literal — no origin.
 *
 * The fixture is a recipe app and shares nothing with the eSIM corpus
 * (`genericRepoShapes.test.ts`'s discipline).
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

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/** Parses + inlines exactly like `loadStudioPages` does for one page. */
function load(pageRel: string): ParsedNode[] {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const opts = { pageBudget: createPageEvalBudget(), workspaceRoot: tmpDir }
  const parsed = parsePageFile(file, tmpDir, project, opts)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return Object.values(inlineLocalComponents(parsed, sources, project, tmpDir, { evalOptions: opts }).nodes)
}

/** 1-based `line:col` of the first occurrence of `needle` in a workspace file. */
function positionOf(relPath: string, needle: string, occurrence = 0): { line: number; col: number } {
  const lines = fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8').split('\n')
  let seen = 0
  for (let i = 0; i < lines.length; i += 1) {
    let from = 0
    for (;;) {
      const index = lines[i]!.indexOf(needle, from)
      if (index < 0) break
      if (seen === occurrence) return { line: i + 1, col: index + 1 }
      seen += 1
      from = index + 1
    }
  }
  throw new Error(`${needle} not found in ${relPath}`)
}

function withText(nodes: ParsedNode[], text: string): ParsedNode[] {
  return nodes.filter((node) => node.text === text)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-site-origins-'))
  write('components/SectionHeading.tsx', [
    "export function SectionHeading({ title, eyebrow = 'Featured' }: { title: string; eyebrow?: string }) {",
    '  return (',
    '    <header className="section-heading">',
    '      <small>{eyebrow}</small>',
    '      <h2>{title}</h2>',
    '    </header>',
    '  )',
    '}',
    '',
  ].join('\n'))
  write('components/SaveButton.tsx', [
    'export const SaveButton = ({ label, hint }: { label: string; hint: string }) => (',
    '  <button type="button" aria-label={hint}>{label}</button>',
    ')',
    '',
  ].join('\n'))
  write('components/RecipeCard.tsx', [
    "import { SectionHeading } from './SectionHeading'",
    'export function RecipeCard({ heading }: { heading: string }) {',
    '  return (',
    '    <article>',
    '      <SectionHeading title={heading} />',
    '    </article>',
    '  )',
    '}',
    '',
  ].join('\n'))
  write('copy.ts', "export const COPY = { cta: 'Cook tonight' }\n")
  write('pages/Recipes.tsx', [
    "import { SectionHeading } from '../components/SectionHeading'",
    "import { SaveButton } from '../components/SaveButton'",
    "import { RecipeCard } from '../components/RecipeCard'",
    "import { COPY } from '../copy'",
    '',
    "const DISHES = [{ id: 'a', name: 'Ramen' }, { id: 'b', name: 'Pho' }]",
    '',
    'export default function Recipes() {',
    '  return (',
    '    <main>',
    '      <SectionHeading title="Weeknight dinners" />',
    '      <SectionHeading title={COPY.cta} />',
    '      <SaveButton label="Save recipe" hint="Save this recipe" />',
    '      <RecipeCard heading="Soups" />',
    '      {DISHES.map((dish) => (',
    '        <SectionHeading key={dish.id} title={dish.name} />',
    '      ))}',
    '      {DISHES.map((dish) => (',
    '        <SectionHeading key={dish.id} title="Chef pick" />',
    '      ))}',
    "      <SectionHeading title={'Slow ' + 'cooked'} />",
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('call-site origins (WB-6)', () => {
  it('forwarded text points at the call site’s own attribute literal', () => {
    const nodes = load('pages/Recipes.tsx')
    const [heading] = withText(nodes, 'Weeknight dinners')
    expect(heading?.name).toBe('h2')
    expect(heading?.textOrigin).toMatchObject({ rel: 'pages/Recipes.tsx', ...positionOf('pages/Recipes.tsx', '"Weeknight dinners"') })
    expect(heading?.textOrigin?.fingerprint).toMatch(/^literal#/)
  })

  it('a call site that passes a dictionary value chains on to that literal', () => {
    const [heading] = withText(load('pages/Recipes.tsx'), 'Cook tonight')
    expect(heading?.textOrigin).toMatchObject({ rel: 'copy.ts', ...positionOf('copy.ts', "'Cook tonight'") })
  })

  it('a forwarded PROP gets the same origin, per prop', () => {
    const [button] = withText(load('pages/Recipes.tsx'), 'Save recipe')
    expect(button?.name).toBe('button')
    expect(button?.textOrigin).toMatchObject(positionOf('pages/Recipes.tsx', '"Save recipe"'))
    expect(button?.props['aria-label']).toBe('Save this recipe')
    expect(button?.codeProps).toContain('aria-label')
    expect(button?.resolvedProps?.['aria-label']?.origin).toMatchObject({
      rel: 'pages/Recipes.tsx',
      ...positionOf('pages/Recipes.tsx', '"Save this recipe"'),
    })
  })

  it('two inlining hops still land on the page’s literal, and the inner call site says so too', () => {
    const nodes = load('pages/Recipes.tsx')
    const [heading] = withText(nodes, 'Soups')
    const soups = positionOf('pages/Recipes.tsx', '"Soups"')
    expect(heading?.textOrigin).toMatchObject({ rel: 'pages/Recipes.tsx', ...soups })
    // The inner `<SectionHeading title={heading}/>` in RecipeCard.tsx is code
    // there, resolved through the outer call site — its origin is the page's.
    const inner = nodes.find((node) => node.instanceOf?.componentName === 'SectionHeading' && node.props.title === 'Soups')
    expect(inner?.codeProps).toContain('title')
    expect(inner?.resolvedProps?.title?.origin).toMatchObject({ rel: 'pages/Recipes.tsx', ...soups })
  })

  it('a .map row forwarding its own item keeps that item’s origin', () => {
    const nodes = load('pages/Recipes.tsx')
    expect(withText(nodes, 'Ramen')[0]?.textOrigin).toMatchObject(positionOf('pages/Recipes.tsx', "'Ramen'"))
    expect(withText(nodes, 'Pho')[0]?.textOrigin).toMatchObject(positionOf('pages/Recipes.tsx', "'Pho'"))
  })

  it('refuses a literal every .map row shares, a component default, and a computed value', () => {
    const nodes = load('pages/Recipes.tsx')
    const shared = withText(nodes, 'Chef pick')
    expect(shared).toHaveLength(2)
    for (const node of shared) {
      expect(node.textOrigin).toBeUndefined()
      expect(node.codeText).toBe(true)
    }
    const defaults = withText(nodes, 'Featured')
    expect(defaults.length).toBeGreaterThan(0)
    for (const node of defaults) expect(node.textOrigin).toBeUndefined()
    const [computed] = withText(nodes, 'Slow cooked')
    expect(computed).toBeDefined()
    expect(computed?.textOrigin).toBeUndefined()
  })

  it('the component’s own file is never the origin of forwarded text', () => {
    for (const node of load('pages/Recipes.tsx')) {
      expect(node.textOrigin?.rel).not.toBe('components/SectionHeading.tsx')
      expect(node.textOrigin?.rel).not.toBe('components/SaveButton.tsx')
    }
  })
})
