/**
 * `studio_list_tokens` reads the CSS the canvas loads (AI-4).
 *
 * The regression this pins: the tool used to read `.studio/framework.json`,
 * which on every real project is `{"colors":{"tokens":[]}}`, and so answered
 * "no tokens" for a project whose `src/index.css` declares a full palette.
 * Each fixture here is a real temp project directory walked through the same
 * source collection `studio_measure_reference` uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { studioProjectTokenMcpTools } from './projectTokenTools'

const tool = studioProjectTokenMcpTools[0]!

interface Token { name: string; value: string; dark?: string; aliasOf?: string; role?: string; source: string }
interface Result {
  ok: boolean
  total: number
  counts: Record<string, number>
  families: Record<string, Token[]>
  sources: Array<{ file: string; origin: string; tokens: number }>
  nextOffset?: number
  note?: string
}

let dir: string

function write(relPath: string, contents: string): void {
  const full = join(dir, ...relPath.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

async function call(input: Record<string, unknown> = {}): Promise<Result> {
  return (await tool.handler!({ dir, ...input } as never, {} as never)) as Result
}

const INDEX_CSS = [
  ':root {',
  '  --color-brand: #0c9ab0;',
  '  --color-text: var(--color-ink);',
  '  --color-ink: #111111;',
  '  --type-title-size: 18px;',
  '  --type-body-line-height: 1.5;',
  '  --space-md: 16px;',
  '  --radius-card: 12px;',
  '  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.2);',
  '  --z-modal: 100;',
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root {',
  '    --color-ink: #f5f5f5;',
  '  }',
  '}',
  '',
].join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-list-tokens-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A Vite-shaped app: the tokens live in the stylesheet its entry imports. */
function viteProject(): void {
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0', vite: '^6.0.0' } }))
  write('src/main.tsx', "import './index.css'\nimport { App } from './App'\nexport default App\n")
  write('src/App.tsx', 'export function App() { return <main /> }\n')
  write('src/index.css', INDEX_CSS)
}

describe('studio_list_tokens', () => {
  it('lists the tokens src/index.css declares, even when .studio/framework.json is the empty store every real project has', async () => {
    viteProject()
    write('.studio/framework.json', JSON.stringify({ colors: { tokens: [] } }))

    const result = await call()

    expect(result.ok).toBe(true)
    expect(result.total).toBe(9)
    expect(result.families.color!.map((t) => t.name)).toEqual(['--color-brand', '--color-ink', '--color-text'])
  })

  it('reports each token\'s resolved value, its dark value, its alias, and the file:line that declares it', async () => {
    viteProject()

    const { families } = await call()
    const byName = new Map(Object.values(families).flat().map((t) => [t.name, t]))

    expect(byName.get('--color-brand')).toEqual({ name: '--color-brand', value: '#0c9ab0', source: 'src/index.css:2' })
    // An alias resolves to the value it paints, and says what it points at.
    expect(byName.get('--color-text')).toEqual({
      name: '--color-text',
      value: '#111111',
      dark: '#f5f5f5',
      aliasOf: '--color-ink',
      source: 'src/index.css:3',
    })
    expect(byName.get('--color-ink')).toMatchObject({ value: '#111111', dark: '#f5f5f5', source: 'src/index.css:4' })
  })

  it('groups by family, with a role on type tokens', async () => {
    viteProject()

    const { families, counts } = await call()

    expect(counts).toEqual({ color: 3, type: 2, space: 1, radius: 1, shadow: 1, other: 1 })
    expect(families.type!.map((t) => [t.name, t.role])).toEqual([
      ['--type-body-line-height', 'line-height'],
      ['--type-title-size', 'font-size'],
    ])
    expect(families.space!.map((t) => t.name)).toEqual(['--space-md'])
    expect(families.radius!.map((t) => t.name)).toEqual(['--radius-card'])
    expect(families.shadow!.map((t) => t.name)).toEqual(['--shadow-card'])
    expect(families.other!.map((t) => t.name)).toEqual(['--z-modal'])
  })

  it('names every stylesheet it scanned, with its origin and how many tokens it won', async () => {
    viteProject()

    const { sources } = await call()

    expect(sources).toContainEqual({ file: 'src/index.css', origin: 'project', tokens: 9 })
  })

  it('filters by name and by family, and the counts still cover the whole set', async () => {
    viteProject()

    const byName = await call({ filter: 'BRAND' })
    expect(Object.values(byName.families).flat().map((t) => t.name)).toEqual(['--color-brand'])
    expect(byName.total).toBe(1)
    expect(byName.counts.color).toBe(3)

    const byFamily = await call({ family: 'space' })
    expect(Object.keys(byFamily.families)).toEqual(['space'])
  })

  it('paginates with offset/limit and says where to continue', async () => {
    viteProject()

    const first = await call({ limit: 4 })
    expect(Object.values(first.families).flat()).toHaveLength(4)
    expect(first.nextOffset).toBe(4)

    const rest = await call({ offset: first.nextOffset, limit: 400 })
    expect(Object.values(rest.families).flat()).toHaveLength(5)
    expect(rest.nextOffset).toBeUndefined()
  })

  it('says so, rather than failing, when the project declares no tokens at all', async () => {
    write('package.json', JSON.stringify({ name: 'bare' }))
    write('pages/Home.tsx', 'export default function Home() { return <main /> }\n')

    const result = await call()

    expect(result.ok).toBe(true)
    expect(result.total).toBe(0)
    expect(result.families).toEqual({})
    expect(result.note).toContain('no token layer')
  })
})
