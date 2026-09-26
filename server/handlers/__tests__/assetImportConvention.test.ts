/**
 * P5-B3 (IMG-10, OD-12) — which convention a dropped image follows: the page's
 * own. Public stays the default; import mode needs a STRICT majority; Next.js
 * is always public; the folder is where the page's imports already point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { detectImageConvention, readImageConvention } from '../studio/assetImportConvention'
import { resolveDroppedAssetHome } from '../studio/assetDrop'

const IMPORTING_PAGE = [
  "import hero from '../assets/hero.png'",
  "import logo from '../assets/brand/logo.svg'",
  "import badge from '../assets/badge.webp'",
  "import { Button } from '../components/Button'",
  'export default function Home() {',
  '  return <main><img src={hero} /><img src={logo} /><img src={badge} /><Button /></main>',
  '}',
  '',
].join('\n')

describe('detectImageConvention', () => {
  it('a page that imports its images gets import mode, in the folder most of them live in', () => {
    expect(detectImageConvention(IMPORTING_PAGE, 'src/pages/Home.tsx', 'vite')).toEqual({ mode: 'import', targetDir: 'src/assets' })
  })

  it('a page that writes public literals stays public', () => {
    const source = 'export default () => <main><img src="/hero.png" /><img src={"/logo.svg"} /></main>\n'
    expect(detectImageConvention(source, 'src/App.tsx', 'vite')).toEqual({ mode: 'public' })
  })

  it('a tie stays public — import mode needs a strict majority', () => {
    const source = "import hero from './hero.png'\nexport default () => <main><img src={hero} /><img src=\"/logo.png\" /></main>\n"
    expect(detectImageConvention(source, 'src/App.tsx', 'vite')).toEqual({ mode: 'public' })
  })

  it('a page with no images at all stays public', () => {
    expect(detectImageConvention('export default () => <main />\n', 'src/App.tsx', 'vite')).toEqual({ mode: 'public' })
  })

  it('Next.js is always public, however the page imports (an imported image is StaticImageData there)', () => {
    expect(detectImageConvention(IMPORTING_PAGE, 'app/page.tsx', 'next-app')).toEqual({ mode: 'public' })
    expect(detectImageConvention(IMPORTING_PAGE, 'pages/index.tsx', 'next-pages')).toEqual({ mode: 'public' })
  })

  it('alias-only imports count as the convention but name no folder, so the default folder is used', () => {
    const source = "import hero from '@/assets/hero.png'\nexport default () => <img src={hero} />\n"
    expect(detectImageConvention(source, 'src/App.tsx', 'vite')).toEqual({ mode: 'import', targetDir: 'src/assets' })
  })

  it('an import that climbs out of the project names no folder', () => {
    const source = "import hero from '../../../elsewhere/hero.png'\nexport default () => <img src={hero} />\n"
    expect(detectImageConvention(source, 'src/App.tsx', 'vite')).toEqual({ mode: 'import', targetDir: 'src/assets' })
  })

  it('a protocol-relative src is not a public literal', () => {
    const source = "import hero from './hero.png'\nexport default () => <main><img src={hero} /><img src=\"//cdn.test/a.png\" /></main>\n"
    expect(detectImageConvention(source, 'src/App.tsx', 'vite')).toEqual({ mode: 'import', targetDir: 'src' })
  })
})

describe('readImageConvention / resolveDroppedAssetHome — the page path is untrusted', () => {
  let tmpDir: string
  const write = (rel: string, contents: string) => {
    const full = path.join(tmpDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-convention-'))
    write('package.json', JSON.stringify({ name: 'app', devDependencies: { vite: '^5.0.0' } }))
    write('vite.config.ts', 'export default {}\n')
    write('src/pages/Home.tsx', IMPORTING_PAGE)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads the page and answers import mode for the drop home', () => {
    expect(resolveDroppedAssetHome(tmpDir, 'src/pages/Home.tsx')).toEqual({ ok: true, mode: 'import', relToProject: 'src/assets' })
  })

  it('no page named means public, as before', () => {
    const home = resolveDroppedAssetHome(tmpDir)
    expect(home.ok && home.mode).toBe('public')
  })

  for (const hostile of ['../outside.tsx', '/etc/passwd', 'C:\\Windows\\win.ini', 'node_modules/x/index.tsx', 'src/pages/Missing.tsx']) {
    it(`a page path of ${JSON.stringify(hostile)} is never read and falls back to public`, () => {
      expect(readImageConvention(tmpDir, hostile, 'vite')).toEqual({ mode: 'public' })
    })
  }
})
