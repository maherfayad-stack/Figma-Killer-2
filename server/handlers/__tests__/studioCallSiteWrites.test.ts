/**
 * P3-C (WB-6, WB-8) — copy a component receives from its call site is written
 * at the call site, end to end.
 *
 * `<SectionHeading title="Weeknight dinners"/>` renders `<h2>{title}</h2>`.
 * Loaded through the real `loadStudioPages`, the inlined `<h2>` names the call
 * site's literal as its `textOrigin`; the edit the client sends for it (a
 * `literal` edit at that origin, which is what `nodeDiffWriteback.ts` emits)
 * goes through the real `applyStudioEditBatch`, and the file BYTES are asserted:
 * the page's attribute changes, the component's `{title}` binding does not.
 *
 * The refusals are pinned too — a shared `.map`-row literal and a component
 * default stay read-only, so the client never sends a write for them.
 *
 * The fixture is a recipe app and shares nothing with the eSIM corpus
 * (`genericRepoShapes.test.ts`'s discipline).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page, PageNode } from '@core/page-tree'
import { clearPageParseCache } from '../studio/pageParseCache'
import { clearStudioLoadMemo } from '../studio/studioLoadMemo'
import { clearWorkspaceProjects } from '../studio/workspaceProject'
import { loadStudioPages } from '../studioPageLoad'
import { applyStudioEditBatch } from '../studioWriteback'

let wsDir: string

const COMPONENTS: Record<string, string> = {
  'components/SectionHeading.tsx': [
    "export function SectionHeading({ title, eyebrow = 'Featured' }: { title: string; eyebrow?: string }) {",
    '  return (',
    '    <header className="section-heading">',
    '      <small>{eyebrow}</small>',
    '      <h2>{title}</h2>',
    '    </header>',
    '  )',
    '}',
    '',
  ].join('\n'),
  'components/SaveButton.tsx': [
    'export const SaveButton = ({ label, hint }: { label: string; hint: string }) => (',
    '  <button type="button" aria-label={hint}>{label}</button>',
    ')',
    '',
  ].join('\n'),
  'components/RecipeCard.tsx': [
    "import { SectionHeading } from './SectionHeading'",
    'export function RecipeCard({ heading }: { heading: string }) {',
    '  return (',
    '    <article>',
    '      <SectionHeading title={heading} />',
    '    </article>',
    '  )',
    '}',
    '',
  ].join('\n'),
}

const PAGE = [
  "import { SectionHeading } from '../components/SectionHeading'",
  "import { SaveButton } from '../components/SaveButton'",
  "import { RecipeCard } from '../components/RecipeCard'",
  '',
  "const DISHES = [{ id: 'a', name: 'Ramen' }, { id: 'b', name: 'Pho' }]",
  '',
  'export default function Recipes() {',
  '  return (',
  '    <main>',
  '      <SectionHeading title="Weeknight dinners" />',
  '      <SaveButton label="Save recipe" hint="Save this recipe" />',
  '      <RecipeCard heading="Soups" />',
  '      {DISHES.map((dish) => (',
  '        <SectionHeading key={dish.id} title="Chef pick" />',
  '      ))}',
  '    </main>',
  '  )',
  '}',
  '',
].join('\n')

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(wsDir, ...relPath.split('/')), 'utf8')
}

async function recipes(): Promise<Page> {
  const page = (await loadStudioPages(wsDir)).pages.find((candidate) => candidate.title === 'Recipes')
  if (!page) throw new Error('no Recipes page')
  return page
}

function nodesWith(page: Page, key: string, value: string): PageNode[] {
  return Object.values(page.nodes).filter((node) => node.props?.[key] === value)
}

/** The `literal` edit the client emits for a value with an origin, guarded by the origin's fingerprint. */
function writeAtOrigin(origin: NonNullable<PageNode['textOrigin']>, text: string) {
  const nodeId = `${origin.rel}:${origin.line}:${origin.col}`
  return applyStudioEditBatch(wsDir, [{ kind: 'literal', nodeId, text }], origin.fingerprint ? { [nodeId]: origin.fingerprint } : {})
}

beforeEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-call-site-writes-'))
  for (const [rel, contents] of Object.entries(COMPONENTS)) write(rel, contents)
  write('pages/Recipes.tsx', PAGE)
})

afterEach(() => {
  clearPageParseCache()
  clearStudioLoadMemo()
  clearWorkspaceProjects()
  fs.rmSync(wsDir, { recursive: true, force: true })
})

describe('WB-6 — forwarded text is written at the call site', () => {
  it('rewrites the call site’s attribute and leaves the component’s binding alone', async () => {
    const [heading] = nodesWith(await recipes(), 'text', 'Weeknight dinners')
    expect(heading?.id).toContain('~components/SectionHeading.tsx:')
    expect(heading?.codeProps ?? []).not.toContain('text')
    expect(heading?.textOrigin?.rel).toBe('pages/Recipes.tsx')

    const result = writeAtOrigin(heading!.textOrigin!, 'Quick dinners')
    expect(result.refusals).toEqual([])
    expect(result.written).toBe(1)
    expect(read('pages/Recipes.tsx')).toBe(PAGE.replace('title="Weeknight dinners"', 'title="Quick dinners"'))
    expect(read('components/SectionHeading.tsx')).toBe(COMPONENTS['components/SectionHeading.tsx']!)

    // The next load shows it — on the inlined heading and on the instance's own prop.
    clearStudioLoadMemo()
    const reloaded = await recipes()
    expect(nodesWith(reloaded, 'text', 'Quick dinners')).toHaveLength(1)
  })

  it('two inlining hops still write the page’s literal, not the middle component', async () => {
    const [heading] = nodesWith(await recipes(), 'text', 'Soups')
    const result = writeAtOrigin(heading!.textOrigin!, 'Stews')
    expect(result.refusals).toEqual([])
    expect(read('pages/Recipes.tsx')).toBe(PAGE.replace('heading="Soups"', 'heading="Stews"'))
    expect(read('components/RecipeCard.tsx')).toBe(COMPONENTS['components/RecipeCard.tsx']!)
  })

  it('a value with a quote in it keeps the attribute valid', async () => {
    const [heading] = nodesWith(await recipes(), 'text', 'Weeknight dinners')
    writeAtOrigin(heading!.textOrigin!, 'Mum’s "best" dinners')
    expect(read('pages/Recipes.tsx')).toBe(PAGE.replace('title="Weeknight dinners"', 'title=\'Mum’s "best" dinners\''))
    clearStudioLoadMemo()
    expect(nodesWith(await recipes(), 'text', 'Mum’s "best" dinners')).toHaveLength(1)
  })
})

describe('WB-8 — a forwarded PROP with an origin is writable there', () => {
  it('names the call site’s literal for the button’s aria-label, and writes it', async () => {
    const [button] = nodesWith(await recipes(), 'label', 'Save recipe')
    expect(button?.props['aria-label']).toBe('Save this recipe')
    const origin = button?.resolvedProps?.['aria-label']?.origin
    expect(origin?.rel).toBe('pages/Recipes.tsx')

    const result = writeAtOrigin(origin!, 'Keep this recipe')
    expect(result.refusals).toEqual([])
    expect(read('pages/Recipes.tsx')).toBe(PAGE.replace('hint="Save this recipe"', 'hint="Keep this recipe"'))
    expect(read('components/SaveButton.tsx')).toBe(COMPONENTS['components/SaveButton.tsx']!)
  })
})

describe('what stays read-only', () => {
  it('a literal every .map row shares, and a component default, have no origin', async () => {
    const page = await recipes()
    const shared = nodesWith(page, 'text', 'Chef pick')
    expect(shared).toHaveLength(2)
    for (const node of shared) {
      expect(node.textOrigin).toBeUndefined()
      expect(node.codeProps).toContain('text')
    }
    const defaults = nodesWith(page, 'text', 'Featured')
    expect(defaults.length).toBeGreaterThan(0)
    for (const node of defaults) {
      expect(node.textOrigin).toBeUndefined()
      expect(node.codeProps).toContain('text')
    }
  })
})
