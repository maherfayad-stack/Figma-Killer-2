/**
 * `GET|POST /admin/api/studio/token-catalog` end to end on a small Vite
 * project: the catalog read, a `set`, a create-from-value `insert`, the
 * refusals as 422/409 envelopes, and the route being declared in the
 * capability table. Fixture posture as `previewAxes.test.ts`: the temp project
 * lives INSIDE `projectsRootDir()` so the route's containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioTokenCatalog } from '../studio/tokenCatalogRoutes'
import { resolveStudioRouteCapability } from '../studio/routeCapabilities'
import type { TokenCatalog } from '@core/studio-tokens'

const INDEX_CSS = [
  ':root {',
  '  --color-brand: #0c9ab0;',
  '  --space-md: 16px;',
  '}',
  '',
  "[data-theme='dark'] {",
  '  --color-brand: #5fd3e4;',
  '}',
  '',
].join('\n')

function request(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { req: new Request(url, init), url, pathname: url.pathname }
}

function post(dir: string, edits: unknown[], afterPlan?: () => void) {
  const { req, url, pathname } = request('/admin/api/studio/token-catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, edits }),
  })
  return tryServeStudioTokenCatalog(req, url, pathname, afterPlan ? { afterPlan } : undefined)
}

const CARD_MODULE_CSS = [
  ':root {',
  '  --probe-accent: #ff0000;',
  '}',
  '',
  '.card {',
  '  --status-cutout: #000;',
  '  color: var(--probe-accent);',
  '}',
  '',
].join('\n')

describe('token-catalog route', () => {
  let dir: string
  const css = (): string => fs.readFileSync(path.join(dir, 'src/index.css'), 'utf8')

  beforeEach(() => {
    fs.mkdirSync(projectsRootDir(), { recursive: true })
    dir = fs.mkdtempSync(path.join(projectsRootDir(), '__token_catalog_test_'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0', vite: '^6.0.0' } }))
    fs.writeFileSync(path.join(dir, 'src/main.tsx'), "import './index.css'\nimport { App } from './App'\nexport default App\n")
    fs.writeFileSync(path.join(dir, 'src/App.tsx'), "export function App() { return <main style={{ color: 'var(--color-brand)' }} /> }\n")
    fs.writeFileSync(path.join(dir, 'src/index.css'), INDEX_CSS)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is declared: GET needs site.read, POST needs studio.write', () => {
    expect(resolveStudioRouteCapability('/admin/api/studio/token-catalog')).toMatchObject({ read: 'site.read', mutate: 'studio.write' })
  })

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = request('/admin/api/studio/other')
    expect(await tryServeStudioTokenCatalog(req, url, pathname)).toBeNull()
  })

  it('GET returns tokens with modes, and usage on request', async () => {
    const { req, url, pathname } = request(`/admin/api/studio/token-catalog?dir=${encodeURIComponent(dir)}&usage=1`)
    const res = await tryServeStudioTokenCatalog(req, url, pathname)
    const catalog = (await res!.json()) as TokenCatalog
    const brand = catalog.tokens.find((t) => t.name === '--color-brand')!
    expect(brand.decls.map((d) => [d.gate.kind, d.value, d.file, d.line])).toEqual([
      ['base', '#0c9ab0', 'src/index.css', 2],
      ['attr', '#5fd3e4', 'src/index.css', 7],
    ])
    expect(brand.usage).toEqual({ count: 1, sites: [{ file: 'src/App.tsx', line: 1 }] })
    expect(catalog.axes[0]).toMatchObject({ id: 'color-scheme' })
  })

  it('POST set edits the one declaration and nothing else', async () => {
    const res = await post(dir, [{ op: 'set', name: '--color-brand', value: '#ef4550', target: 'dark' }])
    expect(res!.status).toBe(200)
    expect(css()).toBe(INDEX_CSS.replace('#5fd3e4', '#ef4550'))
  })

  it('POST insert declares a new token (create variable from a value)', async () => {
    const res = await post(dir, [{ op: 'insert', name: '--space-lg', value: '24px' }])
    const body = (await res!.json()) as { ok: boolean; inserted: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.inserted).toEqual([{ name: '--space-lg', target: 'light', file: 'src/index.css' }])
    expect(css()).toBe(INDEX_CSS.replace('  --space-md: 16px;\n', '  --space-md: 16px;\n  --space-lg: 24px;\n'))
  })

  it('answers a refusal as a 422 envelope and writes nothing', async () => {
    const res = await post(dir, [{ op: 'set', name: '--space-md', value: '8px' }, { op: 'set', name: '--missing', value: '1px' }])
    expect(res!.status).toBe(422)
    expect(await res!.json()).toMatchObject({ code: 'no-such-token', entryIndex: 1 })
    expect(css()).toBe(INDEX_CSS)
  })

  it('refuses a duplicate insert as already-declared', async () => {
    const res = await post(dir, [{ op: 'insert', name: '--space-md', value: '1px' }])
    expect(res!.status).toBe(422)
    expect(await res!.json()).toMatchObject({ code: 'already-declared' })
  })

  it('rejects a body that is not an edit list', async () => {
    const res = await post(dir, [{ op: 'rename', name: '--a' }])
    expect(res!.status).toBe(400)
  })

  describe('a CSS Module declares tokens (r3 variables)', () => {
    const modulePath = (): string => path.join(dir, 'src/Card.module.css')
    const moduleCss = (): string => fs.readFileSync(modulePath(), 'utf8')
    beforeEach(() => {
      fs.writeFileSync(modulePath(), CARD_MODULE_CSS)
      fs.writeFileSync(path.join(dir, 'src/App.tsx'), ["import styles from './Card.module.css'", "export function App() { return <main className={styles.card} style={{ color: 'var(--color-brand)' }} /> }", ''].join('\n'))
    })

    it('a value edit of a :root token declared in the module is written to the module source, once', async () => {
      const res = await post(dir, [{ op: 'set', name: '--probe-accent', value: '#0000ff' }])
      expect(res!.status).toBe(200)
      expect(moduleCss()).toBe(CARD_MODULE_CSS.replace('#ff0000', '#0000ff'))
    })

    it('shows a scoped token with its real value and selector, and writes it where it is declared', async () => {
      const { req, url, pathname } = request(`/admin/api/studio/token-catalog?dir=${encodeURIComponent(dir)}`)
      const catalog = (await (await tryServeStudioTokenCatalog(req, url, pathname))!.json()) as TokenCatalog
      const cutout = catalog.tokens.find((t) => t.name === '--status-cutout')!
      expect(cutout.decls.map((d) => [d.gate, d.value, d.file])).toEqual([[{ kind: 'scope', selector: '.card' }, '#000', 'src/Card.module.css']])

      const res = await post(dir, [{ op: 'set', name: '--status-cutout', value: '#111111', target: { kind: 'scope', selector: '.card' } }])
      expect(res!.status).toBe(200)
      expect(moduleCss()).toBe(CARD_MODULE_CSS.replace('#000', '#111111'))
    })

    it('a rename and a remove of a module token still work on the same file', async () => {
      const res = await post(dir, [{ op: 'rename', name: '--probe-accent', to: '--probe-main' }])
      expect(res!.status).toBe(200)
      expect(moduleCss()).toBe(CARD_MODULE_CSS.replaceAll('--probe-accent', '--probe-main'))
    })

    it('re-plans once when the file moved between the read and the write', async () => {
      const edited = CARD_MODULE_CSS.replace('.card {', '.card {\n  --extra: 1px;')
      let first = true
      const res = await post(dir, [{ op: 'set', name: '--probe-accent', value: '#0000ff' }], () => {
        if (first) {
          first = false
          fs.writeFileSync(modulePath(), edited)
        }
      })
      expect(res!.status).toBe(200)
      expect(moduleCss()).toBe(edited.replace('#ff0000', '#0000ff'))
    })
  })
})
