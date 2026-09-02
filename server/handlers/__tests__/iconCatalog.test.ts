/**
 * iconCatalog — coverage for `GET /admin/api/studio/icons`.
 *
 * The defect this route exists for: a design system's icons are FILES, and
 * the slot picker could only ever see React exports, so `@alm-design/design-
 * system`'s 568-file `src/icons/` tree was invisible and an icon slot was
 * offered ten chevrons. The cases below pin the three properties that make
 * the catalogue trustworthy — it finds the files, it caps what it will
 * inline, and it never walks a package that ships no icons.
 *
 * Same fixture posture as `components.test.ts`: a temp dir INSIDE
 * `projectsRootDir()` so the route's own containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioIcons } from '../studio/iconCatalog'

function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  return { req: new Request(url, init), url, pathname: url.pathname }
}

const GLYPH = '<svg viewBox="0 0 24 24"><path d="M9 4.5L16.5 12" stroke="currentColor"/></svg>'

let wsDir: string

beforeEach(() => {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  wsDir = fs.mkdtempSync(path.join(root, '__icons_route_test_'))
})

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

/**
 * A minimal installed package the probe classifies as a component package —
 * a built entry that both creates JSX and exports a PascalCase binding, which
 * is exactly the two-part rule `componentPackageDetect.ts` applies.
 */
function installComponentPackage(name: string): void {
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: { [name]: '1.0.0' } }))
  write(`node_modules/${name}/package.json`, JSON.stringify({ name, main: './dist/index.js' }))
  write(
    `node_modules/${name}/dist/index.js`,
    "import { jsx } from 'react/jsx-runtime'\nexport function Button(){ return jsx('button', {}) }\n",
  )
}

async function getIcons(): Promise<{ id: string; name: string; group: string; markup: string }[]> {
  const { req, url, pathname } = makeRequest(`/admin/api/studio/icons?dir=${encodeURIComponent(wsDir)}`)
  const res = await tryServeStudioIcons(req, url, pathname)
  expect(res?.status).toBe(200)
  const body = (await res!.json()) as { icons: { id: string; name: string; group: string; markup: string }[] }
  return body.icons
}

describe('tryServeStudioIcons', () => {
  it('returns null for an unrelated path', async () => {
    const { req, url } = makeRequest('/admin/api/studio/components')
    expect(await tryServeStudioIcons(req, url, '/admin/api/studio/components')).toBeNull()
  })

  it('finds the SVG files an installed component package ships, with their group and markup', async () => {
    installComponentPackage('@fixture/ds')
    write('node_modules/@fixture/ds/src/icons/line-icons/wifi.svg', GLYPH)
    write('node_modules/@fixture/ds/src/icons/line-icons/passport.svg', GLYPH)

    const icons = await getIcons()
    expect(icons.map((i) => i.name).sort()).toEqual(['passport', 'wifi'])
    expect(icons[0]!.group).toBe('line-icons')
    expect(icons[0]!.id).toBe('@fixture/ds:line-icons/passport.svg')
    // Markup rides along so the picker can preview AND write without a second
    // request — see the route's own doc for why that is affordable.
    expect(icons[0]!.markup).toContain('<path')
  })

  it('walks a nested group, and skips a file too large to inline', async () => {
    installComponentPackage('@fixture/ds')
    write('node_modules/@fixture/ds/src/icons/logotypes/flags/qa.svg', GLYPH)
    // A country flag — real ones in this package run to 93 KB. Not an error,
    // just not an icon anyone should have buried in their JSX.
    write(
      'node_modules/@fixture/ds/src/icons/logotypes/flags/huge.svg',
      `<svg viewBox="0 0 24 24"><path d="${'M0 0'.repeat(2000)}"/></svg>`,
    )

    const icons = await getIcons()
    expect(icons.map((i) => i.name)).toEqual(['qa'])
    expect(icons[0]!.group).toBe('logotypes/flags')
  })

  it('yields an empty catalogue for a project whose packages ship no icons', async () => {
    installComponentPackage('@fixture/ds')
    expect(await getIcons()).toEqual([])
  })

  it('ignores non-SVG files sitting in an icon directory', async () => {
    installComponentPackage('@fixture/ds')
    write('node_modules/@fixture/ds/src/icons/line-icons/wifi.svg', GLYPH)
    write('node_modules/@fixture/ds/src/icons/line-icons/index.js', 'export default 1')
    write('node_modules/@fixture/ds/src/icons/line-icons/notes.md', '# icons')

    expect((await getIcons()).map((i) => i.name)).toEqual(['wifi'])
  })
})
