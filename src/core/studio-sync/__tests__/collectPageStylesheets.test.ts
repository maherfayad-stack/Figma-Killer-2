/**
 * collectPageStylesheets — §6.1 unit tests: which stylesheets a parsed page
 * depends on, in what order, and what must never be reachable.
 *
 * Uses real temp fixture trees (not in-memory ts-morph), matching
 * `staticEval.test.ts`/`componentSources.test.ts` — the module resolves
 * specifiers against real filesystem paths and stats each candidate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createWorkspaceProject,
  inlineLocalComponents,
  parsePageFile,
  resolveComponentSources,
  type ParsedPage,
} from '@core/page-parser'
import { collectEntryStylesheets, collectPageStylesheets } from '../collectPageStylesheets'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-stylesheets-'))
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

/** Parses + inlines a page the way the real load pipeline does, so `loc.file` carries every contributing component file. */
function parseAndInline(pageRel: string): { parsed: ParsedPage; project: ReturnType<typeof createWorkspaceProject> } {
  const file = path.join(tmpDir, ...pageRel.split('/'))
  const project = createWorkspaceProject(tmpDir)
  const parsed = parsePageFile(file, tmpDir, project)
  const sources = resolveComponentSources(project, file, tmpDir, parsed)
  return { parsed: inlineLocalComponents(parsed, sources, project, tmpDir), project }
}

function collect(pageRel: string): string[] {
  const { parsed, project } = parseAndInline(pageRel)
  return collectPageStylesheets(parsed, pageRel, project, tmpDir).map((s) => s.relPath)
}

describe('collectPageStylesheets', () => {
  it('collects the page own stylesheet imports in source order', () => {
    write('pages/base.css', '.a { color: red }')
    write('pages/Home.css', '.b { color: blue }')
    write(
      'pages/Home.tsx',
      [
        "import './base.css'",
        "import './Home.css'",
        'export default function Home() {',
        '  return <div className="a" />',
        '}',
        '',
      ].join('\n'),
    )

    expect(collect('pages/Home.tsx')).toEqual(['pages/base.css', 'pages/Home.css'])
  })

  it('follows into a locally-inlined component and picks up ITS stylesheet', () => {
    write('components/Card.css', '.card { padding: 4px }')
    write(
      'components/Card.tsx',
      ["import './Card.css'", 'export default function Card() {', '  return <div className="card" />', '}', ''].join('\n'),
    )
    write('pages/Home.css', '.page { margin: 0 }')
    write(
      'pages/Home.tsx',
      [
        "import Card from '../components/Card'",
        "import './Home.css'",
        'export default function Home() {',
        '  return <div className="page"><Card /></div>',
        '}',
        '',
      ].join('\n'),
    )

    // Page first (it is always the first contributing file), then the
    // component whose nodes were spliced in.
    expect(collect('pages/Home.tsx')).toEqual(['pages/Home.css', 'components/Card.css'])
  })

  it('dedupes a stylesheet imported by both the page and a component, keeping the first position', () => {
    write('shared.css', '.shared { color: red }')
    write(
      'components/Card.tsx',
      ["import '../shared.css'", 'export default function Card() {', '  return <div className="shared" />', '}', ''].join('\n'),
    )
    write(
      'pages/Home.tsx',
      [
        "import Card from '../components/Card'",
        "import '../shared.css'",
        'export default function Home() {',
        '  return <div><Card /></div>',
        '}',
        '',
      ].join('\n'),
    )

    expect(collect('pages/Home.tsx')).toEqual(['shared.css'])
  })

  it('ignores bare package specifiers — a dependency stylesheet is not the user CSS', () => {
    write('pages/Home.css', '.page { margin: 0 }')
    write(
      'pages/Home.tsx',
      [
        "import '@alm-design/design-system/dist/styles.css'",
        "import './Home.css'",
        'export default function Home() {',
        '  return <div className="page" />',
        '}',
        '',
      ].join('\n'),
    )

    expect(collect('pages/Home.tsx')).toEqual(['pages/Home.css'])
  })

  it('rejects a specifier that escapes the workspace root, even when the file exists', () => {
    // A real, readable .css file OUTSIDE the workspace.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    try {
      fs.writeFileSync(path.join(outsideDir, 'secret.css'), '.secret { color: red }', 'utf8')
      const escapeSpecifier = path.relative(path.join(tmpDir, 'pages'), path.join(outsideDir, 'secret.css')).split(path.sep).join('/')
      expect(escapeSpecifier.startsWith('..')).toBe(true)

      write(
        'pages/Home.tsx',
        [`import '${escapeSpecifier}'`, 'export default function Home() {', '  return <div />', '}', ''].join('\n'),
      )

      expect(collect('pages/Home.tsx')).toEqual([])
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('skips a stylesheet import whose file does not exist', () => {
    write(
      'pages/Home.tsx',
      ["import './missing.css'", 'export default function Home() {', '  return <div />', '}', ''].join('\n'),
    )

    expect(collect('pages/Home.tsx')).toEqual([])
  })

  it('strips a Vite query suffix when resolving', () => {
    write('pages/Home.css', '.page { margin: 0 }')
    write(
      'pages/Home.tsx',
      ["import './Home.css?inline'", 'export default function Home() {', '  return <div className="page" />', '}', ''].join('\n'),
    )

    expect(collect('pages/Home.tsx')).toEqual(['pages/Home.css'])
  })

  it('ignores non-stylesheet imports', () => {
    write('pages/helper.ts', 'export const x = 1')
    write(
      'pages/Home.tsx',
      ["import { x } from './helper'", 'export default function Home() {', '  return <div data-x={x} />', '}', ''].join('\n'),
    )

    expect(collect('pages/Home.tsx')).toEqual([])
  })
})

describe('collectEntryStylesheets', () => {
  function collectEntry(): string[] {
    return collectEntryStylesheets(createWorkspaceProject(tmpDir), tmpDir).map((s) => s.relPath)
  }

  /** The Vite layout every real repo uses: index.html -> main -> index.css, and main -> App -> App.css. */
  function writeViteApp(): void {
    write('index.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>')
    write('src/index.css', ':root { --space: 16px }')
    write('src/App.css', ':root { --space-lg: 24px }')
    write('src/App.jsx', ["import './App.css'", 'export default function App() { return <div /> }', ''].join('\n'))
    write(
      'src/main.jsx',
      ["import './index.css'", "import App from './App.jsx'", 'export default App', ''].join('\n'),
    )
  }

  it('follows the index.html entry through the module graph to reach global CSS', () => {
    writeViteApp()
    // `App.css` is two hops from the entry and is imported by no page — without
    // the graph walk its design tokens are silently missing.
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])
  })

  it('falls back to a conventional entry path when there is no index.html', () => {
    writeViteApp()
    fs.rmSync(path.join(tmpDir, 'index.html'))

    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])
  })

  it('returns nothing when the workspace has no recognisable entry', () => {
    write('pages/Home.tsx', 'export default function Home() { return <div /> }')

    expect(collectEntry()).toEqual([])
  })

  it('does not follow package specifiers out of the workspace', () => {
    write('index.html', '<!doctype html><html><body><script type="module" src="/src/main.jsx"></script></body></html>')
    write('src/index.css', ':root { --space: 16px }')
    write(
      'src/main.jsx',
      ["import '@alm-design/design-system/dist/index.css'", "import './index.css'", 'export default 1', ''].join('\n'),
    )

    expect(collectEntry()).toEqual(['src/index.css'])
  })

  it('survives an import cycle between entry modules', () => {
    write('index.html', '<!doctype html><html><body><script type="module" src="/src/main.jsx"></script></body></html>')
    write('src/a.css', '.a { color: red }')
    write('src/main.jsx', ["import './App.jsx'", "import './a.css'", 'export const m = 1', ''].join('\n'))
    write('src/App.jsx', ["import './main.jsx'", 'export const a = 1', ''].join('\n'))

    expect(collectEntry()).toEqual(['src/a.css'])
  })
})
