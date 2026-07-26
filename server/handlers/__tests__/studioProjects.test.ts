/**
 * studioProjects.ts — unit tests for the configurable page-source override
 * (§1 of STUDIO-ESIM-IMPORT-PLAN.md): `projectPagesDir`'s meta-driven
 * resolution + containment guard, `discoverPageFiles`'s widened `.tsx`/`.jsx`
 * discovery, and `pageIdFromRelPath`'s widened extension strip on a nested
 * `.jsx` path. Fixture style mirrors `studio.test.ts`'s temp-dir pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { discoverPageFiles, projectPagesDir, renameProjectDisplayName, writeProjectMeta } from '../studioProjects'
import { pageIdFromRelPath } from '../studioPageLoad'

describe('projectPagesDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pages-dir-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('defaults to "<dir>/pages" when there is no meta.json at all', () => {
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('defaults to "<dir>/pages" when meta.json has no pagesDir field', () => {
    writeProjectMeta(tmpDir, { displayName: 'Untitled' })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('honours a valid nested pagesDir override', () => {
    writeProjectMeta(tmpDir, { displayName: 'eSIM Journey', pagesDir: 'src/screens' })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'src', 'screens'))
  })

  it('honours a pagesDir override even when the meta has no displayName at all', () => {
    // A hand-written meta.json carrying ONLY pagesDir must not silently lose
    // the override just because it never set a display name.
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    fs.writeFileSync(metaFile, JSON.stringify({ pagesDir: 'app/screens' }))
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'app', 'screens'))
  })

  it('ignores a pagesDir override containing a ".." segment, falling back to the default', () => {
    writeProjectMeta(tmpDir, { displayName: 'Evil', pagesDir: '../../etc' })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('ignores a pagesDir override that is an absolute path, falling back to the default', () => {
    const absoluteElsewhere = path.join(os.tmpdir(), 'somewhere-else')
    writeProjectMeta(tmpDir, { displayName: 'Evil', pagesDir: absoluteElsewhere })
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })

  it('ignores an empty-string pagesDir override, falling back to the default', () => {
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    fs.mkdirSync(path.dirname(metaFile), { recursive: true })
    fs.writeFileSync(metaFile, JSON.stringify({ displayName: 'Blank', pagesDir: '   ' }))
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'pages'))
  })
})

/**
 * discoverPageFiles — widened to `.tsx` AND `.jsx` (§1.2), same recursive
 * walk/exclusion policy as before.
 */
describe('discoverPageFiles — .jsx/.tsx discovery', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-discover-jsx-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function write(relPath: string): void {
    const full = path.join(tmpDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'export default function X() { return null }', 'utf8')
  }

  it('finds a flat top-level .jsx file', () => {
    write('HomepageScreen.jsx')
    expect(discoverPageFiles(tmpDir)).toEqual(['HomepageScreen.jsx'])
  })

  it('finds both .tsx and .jsx files, recursively, in sorted order', () => {
    write('src/screens/HomepageScreen.jsx')
    write('src/screens/esim/QrCodeScreen.jsx')
    write('pages/About.tsx')
    expect(discoverPageFiles(tmpDir)).toEqual([
      'pages/About.tsx',
      'src/screens/HomepageScreen.jsx',
      'src/screens/esim/QrCodeScreen.jsx',
    ])
  })

  it('still ignores non-page files sitting alongside .jsx files', () => {
    write('Home.jsx')
    write('Home.module.css')
    write('README.md')
    expect(discoverPageFiles(tmpDir)).toEqual(['Home.jsx'])
  })
})

describe('renameProjectDisplayName', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-rename-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('changes the display name without disturbing an existing pagesDir override', () => {
    writeProjectMeta(tmpDir, { displayName: 'eSIM Journey', pagesDir: 'src/screens' })

    renameProjectDisplayName(tmpDir, 'eSIM Journey (renamed)')

    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { displayName: string; pagesDir?: string }
    expect(meta.displayName).toBe('eSIM Journey (renamed)')
    expect(meta.pagesDir).toBe('src/screens')
    expect(projectPagesDir(tmpDir)).toBe(path.join(tmpDir, 'src', 'screens'))
  })

  it('sets the display name on a project with no prior meta.json at all', () => {
    renameProjectDisplayName(tmpDir, 'Untitled Renamed')
    const metaFile = path.join(tmpDir, '.studio', 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { displayName: string }
    expect(meta.displayName).toBe('Untitled Renamed')
  })
})

describe('pageIdFromRelPath — widened .jsx extension strip', () => {
  it('strips a nested .jsx path the same way it strips .tsx', () => {
    expect(pageIdFromRelPath('screens/esim/QrCodeScreen.jsx')).toBe('screens-esim-qr-code-screen')
  })

  it('still strips .tsx (non-regression)', () => {
    expect(pageIdFromRelPath('screens/esim/QrCodeScreen.tsx')).toBe('screens-esim-qr-code-screen')
  })
})
