/**
 * componentSources — unit tests for local-vs-package component
 * classification (Phase 7A — multi-file workspace backend).
 *
 * Uses real temp fixture trees (not in-memory ts-morph) because module
 * resolution — relative imports, tsconfig path aliases, and the
 * inside-workspace/inside-node_modules distinction — depends on real
 * filesystem paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parsePageFile } from '../parsePageFile'
import { createWorkspaceProject, resolveComponentSources } from '../componentSources'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-sources-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function byName(nodes: Record<string, { name: string; id: string }>, name: string): string {
  const node = Object.values(nodes).find((n) => n.name === name)
  if (!node) throw new Error(`no parsed node named "${name}"`)
  return node.id
}

describe('resolveComponentSources', () => {
  it('classifies a relative-import component as local, recording its workspace-relative file', () => {
    write('components/Header.tsx', 'export default function Header() { return null }')
    const pageFile = write(
      'pages/Home.tsx',
      [
        "import Header from '../components/Header'",
        'export default function Home() {',
        '  return <Header />',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    const headerId = byName(parsed.nodes, 'Header')
    expect(sources[headerId]).toEqual({ kind: 'local', file: 'components/Header.tsx' })
  })

  it('classifies a bare-specifier (package) import as package, recording its specifier', () => {
    const pageFile = write(
      'pages/Home.tsx',
      [
        "import { Button } from '@alm-design/design-system'",
        'export default function Home() {',
        '  return <Button label="x" />',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    const buttonId = byName(parsed.nodes, 'Button')
    expect(sources[buttonId]).toEqual({ kind: 'package', specifier: '@alm-design/design-system' })
  })

  it('classifies a default-imported local component the same as a named one', () => {
    write('components/Nav.tsx', 'export function Nav() { return null }')
    write('components/Header.tsx', 'export default function Header() { return null }')
    const pageFile = write(
      'pages/Home.tsx',
      [
        "import Header from '../components/Header'",
        "import { Nav } from '../components/Nav'",
        'export default function Home() {',
        '  return <div><Header /><Nav /></div>',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    expect(sources[byName(parsed.nodes, 'Header')]).toEqual({ kind: 'local', file: 'components/Header.tsx' })
    expect(sources[byName(parsed.nodes, 'Nav')]).toEqual({ kind: 'local', file: 'components/Nav.tsx' })
  })

  it('resolves a tsconfig path-alias import to the same local classification as a relative import', () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['*'] }, jsx: 'react-jsx' } }),
    )
    write('components/Header.tsx', 'export default function Header() { return null }')
    const pageFile = write(
      'pages/Home.tsx',
      [
        "import Header from '@/components/Header'",
        'export default function Home() {',
        '  return <Header />',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    expect(sources[byName(parsed.nodes, 'Header')]).toEqual({ kind: 'local', file: 'components/Header.tsx' })
  })

  it('classifies a component declared in the same page file (not imported) as local, pointing at that file', () => {
    const pageFile = write(
      'pages/Home.tsx',
      [
        'function Inline() { return null }',
        'export default function Home() {',
        '  return <Inline />',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    expect(sources[byName(parsed.nodes, 'Inline')]).toEqual({ kind: 'local', file: 'pages/Home.tsx' })
  })

  it('classifies an import resolving inside node_modules as package, even if it has a real source file', () => {
    write(
      'node_modules/some-lib/index.tsx',
      'export function LibThing() { return null }',
    )
    const pageFile = write(
      'pages/Home.tsx',
      [
        "import { LibThing } from 'some-lib'",
        'export default function Home() {',
        '  return <LibThing />',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    expect(sources[byName(parsed.nodes, 'LibThing')]).toEqual({ kind: 'package', specifier: 'some-lib' })
  })

  it('omits intrinsic element nodes (kind: "element") from the classification map', () => {
    const pageFile = write(
      'pages/Home.tsx',
      ['export default function Home() {', '  return <div>hi</div>', '}', ''].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    expect(Object.keys(sources)).toEqual([])
  })

  it('lets a page import a LOCAL component that itself lives several directories deep', () => {
    write('src/shared/ui/Header.tsx', 'export default function Header() { return null }')
    const pageFile = write(
      'pages/marketing/Landing.tsx',
      [
        "import Header from '../../src/shared/ui/Header'",
        'export default function Landing() {',
        '  return <Header />',
        '}',
        '',
      ].join('\n'),
    )

    const project = createWorkspaceProject(tmpDir)
    const parsed = parsePageFile(pageFile, tmpDir, project)
    const sources = resolveComponentSources(project, pageFile, tmpDir, parsed)

    expect(sources[byName(parsed.nodes, 'Header')]).toEqual({ kind: 'local', file: 'src/shared/ui/Header.tsx' })
  })
})
