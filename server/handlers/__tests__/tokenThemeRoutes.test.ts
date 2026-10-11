/**
 * CT-6 through `POST|GET /admin/api/studio/token-catalog` against a real temp
 * Tailwind v4 project: editing an `@theme` value writes one declaration and the
 * journal token puts the file back byte for byte; renaming it moves the
 * declaration, the `var()` reads AND the utility classes in a TSX file and an
 * `@apply`, in one write, and one token restores all three (one file CRLF);
 * the panel's read (`usage=1`) counts classes as uses and lists the JavaScript
 * theme beside the CSS tokens. A bakery storefront, not the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTokenCatalog } from '../studio/tokenCatalogRoutes'
import { restoreUndoJournal } from '../studio/undoJournal'
import type { TokenCatalog } from '@core/studio-tokens'

const THEME_CSS = ['@import "tailwindcss";', '', '@theme {', '  --color-crust: #c58940;', '  --color-cream: #fff7e8;', '  --spacing-gutter: 2rem;', '}', ''].join('\r\n')
const SITE_CSS = ['.hero {', '  @apply bg-crust text-cream;', '}', ''].join('\n')
const MENU_TSX = [
  'export function Menu({ tone }: { tone: string }) {',
  '  return (',
  '    <section className="bg-crust text-cream hover:border-crust/50">',
  '      <i className={`bg-${tone}`} />',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n')
const CONFIG_JS = ["module.exports = {", "  theme: { extend: { colors: { berry: '#8e2a4b' } } },", '}', ''].join('\n')

function post(dir: string, edits: unknown[]) {
  const url = new URL('http://localhost/admin/api/studio/token-catalog')
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir, edits }) })
  return tryServeStudioTokenCatalog(req, url, url.pathname)
}

async function readCatalog(dir: string): Promise<TokenCatalog> {
  const url = new URL(`http://localhost/admin/api/studio/token-catalog?dir=${encodeURIComponent(dir)}&usage=1`)
  return (await (await tryServeStudioTokenCatalog(new Request(url), url, url.pathname))!.json()) as TokenCatalog
}

describe('Tailwind v4 @theme through the token-catalog route', () => {
  let dir: string
  const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8')

  beforeEach(() => {
    fs.mkdirSync(projectsRootDir(), { recursive: true })
    dir = fs.mkdtempSync(path.join(projectsRootDir(), '__token_theme_test_'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bakery', dependencies: { react: '^19.0.0', vite: '^6.0.0', tailwindcss: '^4.0.0' } }))
    fs.writeFileSync(path.join(dir, 'src/main.tsx'), "import './theme.css'\nimport './site.css'\nimport { Menu } from './Menu'\nexport default Menu\n")
    fs.writeFileSync(path.join(dir, 'src/theme.css'), THEME_CSS)
    fs.writeFileSync(path.join(dir, 'src/site.css'), SITE_CSS)
    fs.writeFileSync(path.join(dir, 'src/Menu.tsx'), MENU_TSX)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('edits one @theme declaration and the journal token restores the file byte for byte', async () => {
    const res = await post(dir, [{ op: 'set', name: '--color-crust', value: '#b5762e' }])
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { undoToken: string | null; changed: unknown[] }
    expect(read('src/theme.css')).toBe(THEME_CSS.replace('--color-crust: #c58940;', '--color-crust: #b5762e;'))
    expect(read('src/site.css')).toBe(SITE_CSS)
    expect(read('src/Menu.tsx')).toBe(MENU_TSX)
    expect(body.changed).toHaveLength(1)

    expect(body.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(restoreUndoJournal(dir, body.undoToken!).ok).toBe(true)
    expect(read('src/theme.css')).toBe(THEME_CSS)
  })

  it('renames the variable, its var() reads and its utility classes in one write, and one token restores every file', async () => {
    const res = await post(dir, [{ op: 'rename', name: '--color-crust', to: '--color-toast' }])
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { undoToken: string | null; renamed: Array<{ mentions: number; files: number; unfollowed: string[] }> }
    expect(read('src/theme.css')).toBe(THEME_CSS.replace('--color-crust', '--color-toast'))
    expect(read('src/site.css')).toBe(SITE_CSS.replace('@apply bg-crust', '@apply bg-toast'))
    expect(read('src/Menu.tsx')).toBe(MENU_TSX.replace('bg-crust text-cream hover:border-crust/50', 'bg-toast text-cream hover:border-toast/50'))
    expect(body.renamed[0]).toMatchObject({ mentions: 4, files: 3, unfollowed: ['src/Menu.tsx:4'] })

    expect(restoreUndoJournal(dir, body.undoToken!).ok).toBe(true)
    expect(read('src/theme.css')).toBe(THEME_CSS)
    expect(read('src/site.css')).toBe(SITE_CSS)
    expect(read('src/Menu.tsx')).toBe(MENU_TSX)
  })

  it('refuses a rename it cannot follow with a 422 that says why, and writes nothing', async () => {
    const res = await post(dir, [{ op: 'rename', name: '--spacing-gutter', to: '--spacing-edge' }])
    expect(res!.status).toBe(422)
    expect(await res!.json()).toMatchObject({ code: 'rename-blocked' })
    expect(read('src/theme.css')).toBe(THEME_CSS)
  })

  it('counts a utility class as a use of the variable, so "unused" is true', async () => {
    const catalog = await readCatalog(dir)
    const crust = catalog.tokens.find((token) => token.name === '--color-crust')!
    expect(crust.usage!.count).toBe(3)
    expect(crust.usage!.sites.map((site) => `${site.file}:${site.line}`).sort()).toEqual(['src/Menu.tsx:3', 'src/Menu.tsx:3', 'src/site.css:2'])
    expect(catalog.tokens.find((token) => token.name === '--color-cream')!.usage!.count).toBe(2)
    expect(catalog.tokens.find((token) => token.name === '--spacing-gutter')!.usage!.count).toBe(0)
  })

  it('lists the JavaScript theme beside the CSS tokens only on the panel read, and never runs the config', async () => {
    fs.writeFileSync(path.join(dir, 'tailwind.config.js'), `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'RAN'))}, 'x')\n${CONFIG_JS}`)
    const catalog = await readCatalog(dir)
    expect(catalog.jsTheme).toHaveLength(1)
    expect(catalog.jsTheme![0]).toMatchObject({ file: 'tailwind.config.js', group: 'colors', path: 'berry', value: '#8e2a4b' })
    expect(catalog.jsTheme![0]!.utilities).toContain('bg-berry')
    expect(fs.existsSync(path.join(dir, 'RAN'))).toBe(false)

    const url = new URL(`http://localhost/admin/api/studio/token-catalog?dir=${encodeURIComponent(dir)}`)
    const plain = (await (await tryServeStudioTokenCatalog(new Request(url), url, url.pathname))!.json()) as TokenCatalog
    expect(plain.jsTheme).toBeUndefined()
  })
})
