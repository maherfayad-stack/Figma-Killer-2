/**
 * Rename and remove through `POST /admin/api/studio/token-catalog` against a
 * real temp project: tokens in two stylesheets (one CRLF) and mentioned in a
 * TSX file; one write, one journal token, and the token restores every file
 * byte for byte (the "one undoable step" CT-3 promises). Fixture posture as
 * `tokenCatalogRoutes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTokenCatalog } from '../studio/tokenCatalogRoutes'
import { restoreUndoJournal } from '../studio/undoJournal'
import type { TokenCatalog } from '@core/studio-tokens'

const TOKENS_CSS = [':root {', '  --color-brand: #0c9ab0;', '  --space-md: 16px;', '}', '', "[data-theme='dark'] {", '  --color-brand: #5fd3e4;', '}', ''].join('\r\n')
const APP_CSS = ['.btn {', '  color: var(--color-brand);', '  margin: var(--space-md);', '}', ''].join('\n')
const APP_TSX = 'export function App() { return <main className="bg-[--color-brand]" style={{ color: "var(--color-brand)" }} /> }\n'

function post(dir: string, edits: unknown[]) {
  const url = new URL('http://localhost/admin/api/studio/token-catalog')
  const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir, edits }) })
  return tryServeStudioTokenCatalog(req, url, url.pathname)
}

describe('token-catalog rename / remove', () => {
  let dir: string
  const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8')

  beforeEach(() => {
    fs.mkdirSync(projectsRootDir(), { recursive: true })
    dir = fs.mkdtempSync(path.join(projectsRootDir(), '__token_refactor_test_'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0', vite: '^6.0.0' } }))
    fs.writeFileSync(path.join(dir, 'src/main.tsx'), "import './tokens.css'\nimport './app.css'\nimport { App } from './App'\nexport default App\n")
    fs.writeFileSync(path.join(dir, 'src/tokens.css'), TOKENS_CSS)
    fs.writeFileSync(path.join(dir, 'src/app.css'), APP_CSS)
    fs.writeFileSync(path.join(dir, 'src/App.tsx'), APP_TSX)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('renames every declaration and mention in one write, and the journal token puts every file back byte for byte', async () => {
    const res = await post(dir, [{ op: 'rename', name: '--color-brand', to: '--color-primary' }])
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as { renamed: unknown[]; undoToken: string | null; files: Array<{ path: string }> }
    expect(body.renamed).toEqual([{ name: '--color-brand', to: '--color-primary', mentions: 5, files: 3 }])
    expect(read('src/tokens.css')).toBe(TOKENS_CSS.replaceAll('--color-brand', '--color-primary'))
    expect(read('src/app.css')).toBe(APP_CSS.replace('--color-brand', '--color-primary'))
    expect(read('src/App.tsx')).toBe(APP_TSX.replaceAll('--color-brand', '--color-primary'))

    expect(body.undoToken).toMatch(/^[0-9a-f]{32}$/)
    const restored = restoreUndoJournal(dir, body.undoToken!)
    expect(restored.ok).toBe(true)
    expect(read('src/tokens.css')).toBe(TOKENS_CSS)
    expect(read('src/app.css')).toBe(APP_CSS)
    expect(read('src/App.tsx')).toBe(APP_TSX)
  })

  it('refuses to restore once a file has moved on (the undo never overwrites a later change)', async () => {
    const res = await post(dir, [{ op: 'rename', name: '--space-md', to: '--space-base' }])
    const body = (await res!.json()) as { undoToken: string }
    fs.appendFileSync(path.join(dir, 'src/app.css'), '/* later edit */\n')
    expect(restoreUndoJournal(dir, body.undoToken)).toMatchObject({ ok: false, reason: 'restore-stale' })
  })

  it('refuses removing a used token with a 422 naming where, and writes nothing', async () => {
    const res = await post(dir, [{ op: 'remove', name: '--space-md' }])
    expect(res!.status).toBe(422)
    expect(await res!.json()).toMatchObject({ code: 'in-use', details: { declarations: ['src/app.css:3'] } })
    expect(read('src/tokens.css')).toBe(TOKENS_CSS)
  })

  it('removes with a replacement: readers move, declarations go, the count reflects it', async () => {
    await post(dir, [{ op: 'insert', name: '--space-lg', value: '24px' }])
    const res = await post(dir, [{ op: 'remove', name: '--space-md', replaceWith: '--space-lg' }])
    expect(res!.status).toBe(200)
    expect(read('src/app.css')).toBe(APP_CSS.replace('--space-md', '--space-lg'))
    expect(read('src/tokens.css')).not.toContain('--space-md')

    const url = new URL(`http://localhost/admin/api/studio/token-catalog?dir=${encodeURIComponent(dir)}&usage=1`)
    const catalog = (await (await tryServeStudioTokenCatalog(new Request(url), url, url.pathname))!.json()) as TokenCatalog
    expect(catalog.tokens.find((t) => t.name === '--space-md')).toBeUndefined()
    expect(catalog.tokens.find((t) => t.name === '--space-lg')!.usage!.count).toBe(1)
  })
})
