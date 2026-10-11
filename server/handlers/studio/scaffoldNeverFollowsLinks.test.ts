/**
 * Studio's scaffolding writers never write through a link.
 *
 * `existsSync` follows links, so a DANGLING symlink reads as "absent", and a
 * plain `writeFileSync` then creates the file wherever the link points — and
 * on Windows even `wx` follows a dangling link (`sec-23`). A repository
 * imported from GitHub can carry a link at any name Studio scaffolds, so each
 * writer here is driven against one that points out of the project, and the
 * assertion is on the OUTSIDE file: never created, never changed.
 *
 * File symlinks need a privilege some Windows machines do not grant; those
 * cases skip themselves there rather than pass vacuously elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScaffoldedPage } from './pageScaffold'
import { scaffoldProjectI18n } from './i18nScaffold'
import { ensureDesignSystemFiles } from './designSystemFiles'
import { ensurePrototypeShell } from './prototypeShell'
import { applyProjectSeed } from './projectSeed'
import { mergeStudioMeta } from './studioMeta'

let root: string
let project: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-scaffold-links-'))
  project = join(root, 'project')
  outside = join(root, 'outside')
  mkdirSync(join(project, 'pages'), { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A file symlink at `at` pointing to `target`; `false` when this machine refuses to create one. */
function fileLink(target: string, at: string): boolean {
  try {
    mkdirSync(join(at, '..'), { recursive: true })
    symlinkSync(target, at, 'file')
    return true
  } catch {
    return false
  }
}

describe('page scaffold (`studio_create_page`, POST /page)', () => {
  it('a dangling link at the new page name is a taken name; nothing is created where it points', () => {
    const escape = join(outside, 'Evil.tsx')
    if (!fileLink(escape, join(project, 'pages', 'Evil.tsx'))) return
    const result = createScaffoldedPage(project, 'Evil')
    expect(result.ok).toBe(false)
    expect(existsSync(escape)).toBe(false)
  })

  it('a pages folder that is a junction out of the project gets no page', () => {
    rmSync(join(project, 'pages'), { recursive: true, force: true })
    symlinkSync(outside, join(project, 'pages'), 'junction')
    writeFileSync(join(outside, 'Existing.tsx'), 'export default function Existing() { return <div /> }\n')
    const result = createScaffoldedPage(project, 'Planted')
    expect(result.ok).toBe(false)
    expect(existsSync(join(outside, 'Planted.tsx'))).toBe(false)
  })
})

describe('i18n scaffold', () => {
  it('a dangling link at translations.ts refuses; nothing is created where it points', () => {
    mkdirSync(join(project, 'src'), { recursive: true })
    const escape = join(outside, 'translations.ts')
    if (!fileLink(escape, join(project, 'src', 'i18n', 'translations.ts'))) return
    const result = scaffoldProjectI18n(project)
    expect(result.ok).toBe(false)
    expect(existsSync(escape)).toBe(false)
  })
})

describe('the vendored design-system folder', () => {
  it('a dangling link at a file Studio writes there is skipped; nothing is created where it points', () => {
    const source = join(root, 'vendor')
    mkdirSync(join(source, 'src', 'components'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{"name":"alm-design-system","version":"1.0.0"}')
    writeFileSync(join(source, 'src', 'index.js'), "export { Button } from './components/Button'\n")
    writeFileSync(join(source, 'src', 'components', 'Button.jsx'), 'export function Button() { return null }\n')
    mergeStudioMeta(project, { designSystem: 'alm' })
    const escape = join(outside, 'index.js')
    if (!fileLink(escape, join(project, 'design-system', 'index.js'))) return
    const result = ensureDesignSystemFiles(project, { sourceDir: source })
    expect(result.written).not.toContain('index.js')
    expect(existsSync(escape)).toBe(false)
  })
})

describe('the preview shell (every project, on open)', () => {
  it('an imported vite.config.js that links to a file outside is left alone — never "adopted" and overwritten', () => {
    const victim = join(outside, 'victim.js')
    writeFileSync(victim, 'VICTIM')
    if (!fileLink(victim, join(project, 'vite.config.js'))) return
    ensurePrototypeShell(project)
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM')
  })

  it('a dangling index.html or package.json link is never written through', () => {
    const escapeHtml = join(outside, 'index.html')
    const escapePkg = join(outside, 'package.json')
    if (!fileLink(escapeHtml, join(project, 'index.html'))) return
    if (!fileLink(escapePkg, join(project, 'package.json'))) return
    ensurePrototypeShell(project)
    expect(existsSync(escapeHtml)).toBe(false)
    expect(existsSync(escapePkg)).toBe(false)
  })
})

describe('the project seed', () => {
  it('a dangling link at a seed entry name is a taken name; the copy never follows it', () => {
    const seedDir = join(root, 'seed')
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(join(seedDir, 'README.md'), '# seed\n')
    const escape = join(outside, 'README.md')
    if (!fileLink(escape, join(project, 'README.md'))) return
    const result = applyProjectSeed(project, { seedDir, designSystemSourceDir: join(root, 'no-vendor') })
    expect(result.copied).not.toContain('README.md')
    expect(existsSync(escape)).toBe(false)
  })
})
