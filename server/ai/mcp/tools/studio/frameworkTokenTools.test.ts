import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { studioFrameworkTokenMcpTools } from './frameworkTokenTools'

const tool = studioFrameworkTokenMcpTools[0]!

let dir: string

/** One token carrying the full editor configuration a real store holds — the bulk this tool exists to drop. */
function colorToken(slug: string, light: string, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${slug}`,
    category: '',
    slug,
    lightValue: light,
    darkValue: light,
    darkModeEnabled: false,
    generateUtilities: { text: true, background: true, border: true, fill: false },
    generateTransparent: true,
    generateShades: { enabled: true, count: 4 },
    generateTints: { enabled: true, count: 4 },
    order: 0,
    createdAt: 1785603622155,
    updatedAt: 1785603622155,
    ...extra,
  }
}

function writeFramework(framework: unknown): void {
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(join(dir, '.studio', 'framework.json'), JSON.stringify(framework))
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'framework-tokens-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function call(input: Record<string, unknown> = {}) {
  return tool.handler!({ dir, ...input } as never, {} as never)
}

describe('studio_list_tokens', () => {
  it('projects each colour to a name and a value, dropping the editor configuration', async () => {
    writeFramework({ colors: { tokens: [colorToken('color-metal', '#1C1C1C')] } })

    const result = await call() as { ok: boolean; colors: Array<Record<string, unknown>> }

    expect(result.ok).toBe(true)
    expect(result.colors).toEqual([{ name: 'color-metal', value: '#1C1C1C' }])
  })

  // The whole point of the tool: a payload small enough to actually return.
  it('is an order of magnitude smaller than the store it reads', async () => {
    const tokens = Array.from({ length: 226 }, (_, i) => colorToken(`color-${i}`, '#123456'))
    writeFramework({ colors: { tokens } })

    const result = await call()

    const projected = Buffer.byteLength(JSON.stringify(result))
    const store = Buffer.byteLength(JSON.stringify({ colors: { tokens } }))
    expect(projected).toBeLessThan(store / 5)
  })

  it('emits a dark value only when the token actually has a distinct one', async () => {
    writeFramework({
      colors: {
        tokens: [
          colorToken('same', '#fff', { darkModeEnabled: true, darkValue: '#fff' }),
          colorToken('differs', '#fff', { darkModeEnabled: true, darkValue: '#000' }),
          colorToken('disabled', '#fff', { darkModeEnabled: false, darkValue: '#000' }),
        ],
      },
    })

    const result = await call() as { colors: Array<Record<string, unknown>> }

    expect(result.colors).toEqual([
      { name: 'same', value: '#fff' },
      { name: 'differs', value: '#fff', dark: '#000' },
      { name: 'disabled', value: '#fff' },
    ])
  })

  it('filters by name, case-insensitively', async () => {
    writeFramework({
      colors: { tokens: [colorToken('brand-primary', '#a'), colorToken('text-muted', '#b')] },
    })

    const result = await call({ filter: 'BRAND' }) as { colors: Array<{ name: string }>; colorCount: number }

    expect(result.colors.map((c) => c.name)).toEqual(['brand-primary'])
    // The total is still reported, so a filtered view never reads as the whole palette.
    expect(result.colorCount).toBe(2)
  })

  it('summarises the typography and spacing scales', async () => {
    writeFramework({
      typography: { groups: [{ name: 'Imported', namingConvention: 'text-1', steps: 'xs,s,m,l' }] },
      spacing: { groups: [{ name: 'Space', namingConvention: 'space-1', steps: 'xs,s,m' }] },
    })

    const result = await call() as { typography: unknown[]; spacing: unknown[] }

    expect(result.typography).toEqual([{ name: 'Imported', naming: 'text-1', steps: 'xs,s,m,l' }])
    expect(result.spacing).toEqual([{ name: 'Space', naming: 'space-1', steps: 'xs,s,m' }])
  })

  it('reports an empty palette for a project with no tokens yet, rather than failing', async () => {
    const result = await call() as { ok: boolean; colors: unknown[]; note?: string }

    expect(result.ok).toBe(true)
    expect(result.colors).toEqual([])
    expect(result.note).toBeDefined()
  })

  // The framework engine owns this file's shape and will evolve it. A mismatch
  // must degrade to "no tokens", never fail a chat turn.
  it('degrades to an empty result on a malformed store instead of throwing', async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    writeFileSync(join(dir, '.studio', 'framework.json'), '{ not json')

    const result = await call() as { ok: boolean; colors: unknown[] }

    expect(result.ok).toBe(true)
    expect(result.colors).toEqual([])
  })

  it('skips tokens with no name rather than emitting blanks', async () => {
    writeFramework({ colors: { tokens: [colorToken('good', '#a'), { lightValue: '#b' }] } })

    const result = await call() as { colors: Array<{ name: string }> }

    expect(result.colors.map((c) => c.name)).toEqual(['good'])
  })
})
