/**
 * entryStylesheetCache — invalidation-contract tests, exercised through the
 * real public entry point (`collectEntryStylesheets`) rather than the cache
 * primitives directly, because what actually matters is "does a second call
 * see the true current answer", not "did the internal Map do the right
 * thing in isolation". Uses real temp fixture trees and `fs.utimesSync` to
 * force a distinct mtime — same-millisecond writes can otherwise land on an
 * identical `stat()` reading, which would falsely look unchanged (same
 * pattern as `pageParseCache.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject } from '@core/page-parser'
import { collectEntryStylesheets } from '../collectPageStylesheets'
import { clearEntryStylesheetCache } from '../entryStylesheetCache'

let tmpDir: string

beforeEach(() => {
  clearEntryStylesheetCache()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-stylesheet-cache-'))
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

/** Rewrites `absPath` and forces its mtime forward, so a bare re-write within the same millisecond can't hide the change from a mtime-based cache. */
function bumpedRewrite(absPath: string, contents: string): void {
  const bumped = new Date(fs.statSync(absPath).mtime.getTime() + 5000)
  fs.writeFileSync(absPath, contents, 'utf8')
  fs.utimesSync(absPath, bumped, bumped)
}

function collectEntry(): string[] {
  return collectEntryStylesheets(createWorkspaceProject(tmpDir), tmpDir).map((s) => s.relPath)
}

/** index.html -> main -> index.css, and main -> App -> App.css. */
function writeViteApp(): void {
  write('index.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>')
  write('src/index.css', ':root { --space: 16px }')
  write('src/App.css', ':root { --space-lg: 24px }')
  write('src/App.jsx', ["import './App.css'", 'export default function App() { return <div /> }', ''].join('\n'))
  write('src/main.jsx', ["import './index.css'", "import App from './App.jsx'", 'export default App', ''].join('\n'))
}

describe('collectEntryStylesheets caching', () => {
  it('a second call for an unchanged workspace returns the identical result (cache hit)', () => {
    writeViteApp()
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])
  })

  it('invalidates when a VISITED file is edited to add a new import', () => {
    writeViteApp()
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])

    write('src/extra.css', '.extra { color: green }')
    bumpedRewrite(
      path.join(tmpDir, 'src/App.jsx'),
      ["import './App.css'", "import './extra.css'", 'export default function App() { return <div /> }', ''].join('\n'),
    )

    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css', 'src/extra.css'])
  })

  it('invalidates when a VISITED file is edited to remove an import', () => {
    writeViteApp()
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])

    bumpedRewrite(path.join(tmpDir, 'src/App.jsx'), ['export default function App() { return <div /> }', ''].join('\n'))

    expect(collectEntry()).toEqual(['src/index.css'])
  })

  it('invalidates when a VISITED file is edited to repoint an import at a different file', () => {
    writeViteApp()
    write('src/Other.css', '.other { color: purple }')
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])

    bumpedRewrite(
      path.join(tmpDir, 'src/App.jsx'),
      ["import './Other.css'", 'export default function App() { return <div /> }', ''].join('\n'),
    )

    expect(collectEntry()).toEqual(['src/index.css', 'src/Other.css'])
  })

  it('invalidates when a resolved stylesheet is deleted', () => {
    writeViteApp()
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])

    fs.rmSync(path.join(tmpDir, 'src/App.css'))

    expect(collectEntry()).toEqual(['src/index.css'])
  })

  it('invalidates when a previously-missing CSS file the entry already imports gets created', () => {
    // `main.jsx` imports a CSS file that does not exist yet — resolveStylesheetSpecifier
    // skips it silently, same as today's uncached behaviour.
    write('index.html', '<!doctype html><html><body><script type="module" src="/src/main.jsx"></script></body></html>')
    write('src/main.jsx', ["import './missing.css'", 'export default 1', ''].join('\n'))
    expect(collectEntry()).toEqual([])

    write('src/missing.css', '.now-here { color: red }')

    expect(collectEntry()).toEqual(['src/missing.css'])
  })

  it('invalidates when a previously-unresolvable extensionless JS import gets created, reaching its own CSS', () => {
    // `main.jsx` imports `./Widget` (no extension) before `Widget.jsx` exists —
    // the relative-module branch cannot resolve it, so the walk currently just
    // skips it, same as an uncached call would.
    write('index.html', '<!doctype html><html><body><script type="module" src="/src/main.jsx"></script></body></html>')
    write('src/main.jsx', ["import Widget from './Widget'", 'export default Widget', ''].join('\n'))
    expect(collectEntry()).toEqual([])

    write('src/Widget.css', '.widget { color: blue }')
    write('src/Widget.jsx', ["import './Widget.css'", 'export default function Widget() { return <div /> }', ''].join('\n'))

    expect(collectEntry()).toEqual(['src/Widget.css'])
  })

  it('invalidates when a previously-unresolvable directory-style import (index file) gets created', () => {
    write('index.html', '<!doctype html><html><body><script type="module" src="/src/main.jsx"></script></body></html>')
    write('src/main.jsx', ["import Widget from './widget'", 'export default Widget', ''].join('\n'))
    expect(collectEntry()).toEqual([])

    write('src/widget/index.css', '.widget { color: teal }')
    write('src/widget/index.jsx', ["import './index.css'", 'export default function Widget() { return <div /> }', ''].join('\n'))

    expect(collectEntry()).toEqual(['src/widget/index.css'])
  })

  it('does not fall back to a re-walk when nothing tracked has changed, even across many calls', () => {
    writeViteApp()
    for (let i = 0; i < 5; i++) {
      expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])
    }
  })

  it('treats a different resolved entry file as a different cache key — falling back off index.html invalidates on its own', () => {
    writeViteApp()
    expect(collectEntry()).toEqual(['src/index.css', 'src/App.css'])

    // index.html now points at a DIFFERENT entry that pulls in different CSS —
    // the resolved `entry` value changes, so this must not reuse the old
    // cache entry keyed on the previous entry file.
    write('src/other-entry.css', '.other-entry { color: orange }')
    write('src/other-entry.jsx', ["import './other-entry.css'", 'export default 1', ''].join('\n'))
    bumpedRewrite(
      path.join(tmpDir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/other-entry.jsx"></script></body></html>',
    )

    expect(collectEntry()).toEqual(['src/other-entry.css'])
  })
})
